/**
 * Copyright 2016 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {CSS} from '../../../build/amp-access-fewcents-0.1.css';
import {Services} from '../../../src/services';
import {dev, user} from '../../../src/log';
import {dict} from '../../../src/utils/object';
import {installStylesForDoc} from '../../../src/style-installer';
import {listen} from '../../../src/event-helper';
import {removeChildren} from '../../../src/dom';

const TAG = 'amp-access-fewcents';

const CONFIG_URL = 'http://localhost:9000';

const CONFIG_BASE_PATH =
  '/api/v1/amp/?' +
  'article_url=CANONICAL_URL' +
  '&amp_reader_id=READER_ID' +
  '&return_url=RETURN_URL';
const AUTHORIZATION_TIMEOUT = 3000;

const DEFAULT_MESSAGES = {
  defaultButton: 'Unlock Article',
  alreadyPurchasedLink: 'I already bought this',
};

/**
 * @typedef {{
 *   articleTitleSelector: string,
 *   configUrl: (string|undefined),
 *   articleId: (string|undefined),
 *   scrollToTopAfterAuth: (boolean|undefined),
 *   locale: (string|undefined),
 *   localeMessages: (Object|undefined),
 *   region: (string|undefined),
 *   sandbox: (boolean|undefined),
 * }}
 */
let fewcentsConfig_0_2_Def; // eslint-disable-line google-camelcase/google-camelcase

/**
 * @typedef {{
 *   "amount": number,
 *   "currency": string,
 *   "payment_model": string,
 * }}
 */
let PriceDef;

/**
 * @typedef {{
 *   "unit": string,
 *   "value": number,
 * }}
 */
let ExpiryDef;

/**
 * @typedef {{
 *   title: string,
 *   description: string,
 *   sales_model: string,
 *   purchase_url: string,
 *   price: PriceDef,
 *   expiry: ExpiryDef,
 * }}
 */
let PurchaseOption_0_2_Def; // eslint-disable-line google-camelcase/google-camelcase

/**
 * @typedef {{
 *   identify_url: string,
 *   purchase_options: Array<PurchaseOption_0_2_Def>,
 * }}
 */
let PurchaseConfig_0_2_Def; // eslint-disable-line google-camelcase/google-camelcase

/**
 * @typedef {{
 *   singlePurchases: Array<PurchaseOption_0_2_Def>,
 *   timepasses: Array<PurchaseOption_0_2_Def>,
 *   subscriptions: Array<PurchaseOption_0_2_Def>,
 * }}
 */
let PurchaseOptionsDef;

/**
 * @implements {../../amp-access/0.1/access-vendor.AccessVendor}
 */
export class FewcentsVendor {
  /**
   * @param {!../../amp-access/0.1/amp-access.AccessService} accessService
   * @param {!../../amp-access/0.1/amp-access-source.AccessSource} accessSource
   */
  constructor(accessService, accessSource) {
    /** @const */
    this.ampdoc = accessService.ampdoc;

    /** @const @private {!../../amp-access/0.1/amp-access-source.AccessSource} */
    this.accessSource_ = accessSource;

    /** @const @private {!JsonObject} For shape see fewcentsConfig_0_2_Def */
    this.fewcentsConfig_ = this.accessSource_.getAdapterConfig();

    /** @private {?JsonObject} For shape see PurchaseConfig_0_2_Def */
    this.purchaseConfig_ = null;

    /** @private {?Function} */
    this.purchaseButtonListener_ = null;

    /** @private {?Function} */
    this.alreadyPurchasedListener_ = null;

    /** @private {boolean} */
    this.containerEmpty_ = true;

    /** @private {?Node} */
    this.innerContainer_ = null;

    /** @private {?Node} */
    this.purchaseButton_ = null;

    /** @private {string} */
    this.currentLocale_ = this.fewcentsConfig_['locale'] || 'en';

    /** @private {!JsonObject} */
    this.i18n_ = /** @type {!JsonObject} */ (Object.assign(
      dict(),
      DEFAULT_MESSAGES,
      this.fewcentsConfig_['localeMessages'] || dict()
    ));

    /** @private {string} */
    this.purchaseConfigBaseUrl_ = this.getConfigUrl_() + CONFIG_BASE_PATH;
    const articleId = this.fewcentsConfig_['articleId'];
    if (articleId) {
      this.purchaseConfigBaseUrl_ +=
        '&article_id=' + encodeURIComponent(articleId);
    }

    /** @const @private {!../../../src/service/timer-impl.Timer} */
    this.timer_ = Services.timerFor(this.ampdoc.win);

    /** @const @private {!../../../src/service/vsync-impl.Vsync} */
    this.vsync_ = Services.vsyncFor(this.ampdoc.win);

    /** @const @private {!../../../src/service/xhr-impl.Xhr} */
    this.xhr_ = Services.xhrFor(this.ampdoc.win);

    // Install styles.
    installStylesForDoc(this.ampdoc, CSS, () => {}, false, TAG);
  }

  /**
   * @private
   * @return {string}
   */
  getConfigUrl_() {
    return CONFIG_URL;
  }

  /**
   * @return {!Promise<!JsonObject>}
   */
  authorize() {
    return this.getPurchaseConfig_().then(
      (response) => {
        if (response.status === 204) {
          throw user().createError(
            'No merchant domains have been matched for this ' +
              'article, or no paid content configurations are setup.'
          );
        }

        this.emptyContainer_();
        return {access: response.access};
      },
      (err) => {
        if (!err || !err.response) {
          throw err;
        }
        const {response} = err;
        if (response.status !== 402) {
          throw err;
        }
        return response
          .json()
          .catch(() => undefined)
          .then((responseJson) => {
            this.purchaseConfig_ = responseJson;

            // empty before rendering, in case authorization is being called
            // again with the same state
            this.emptyContainer_().then(this.renderPurchaseOverlay_.bind(this));
            return {access: false};
          });
      }
    );
  }

  /**
   * @return {!Promise<Object>}
   * @private
   */
  getPurchaseConfig_() {
    const url = this.purchaseConfigBaseUrl_;
    const urlPromise = this.accessSource_.buildUrl(
      url,
      /* useAuthData */ false
    );
    return urlPromise
      .then((url) => {
        return this.accessSource_.getLoginUrl(url);
      })
      .then((url) => {
        dev().info(TAG, 'Authorization URL: ', url);
        return this.timer_
          .timeoutPromise(
            AUTHORIZATION_TIMEOUT,
            this.xhr_.fetchJson(url, {
              credentials: 'include',
            })
          )
          .then((res) => res.json());
      });
  }

  /**
   * @param {string} name
   * @return {!Element}
   * @private
   */
  createElement_(name) {
    return this.ampdoc.win.document.createElement(name);
  }

  /**
   * @return {!Element}
   * @private
   */
  getContainer_() {
    const id = TAG + '-dialog';
    const dialogContainer = this.ampdoc.getElementById(id);
    return user().assertElement(
      dialogContainer,
      'No element found with id ' + id
    );
  }

  /**
   * @private
   * @return {!Promise}
   */
  emptyContainer_() {
    // no need to do all of this if the container is already empty
    if (this.containerEmpty_) {
      return Promise.resolve();
    }
    if (this.purchaseButtonListener_) {
      this.purchaseButtonListener_();
      this.purchaseButtonListener_ = null;
    }
    if (this.alreadyPurchasedListener_) {
      this.alreadyPurchasedListener_();
      this.alreadyPurchasedListener_ = null;
    }
    return this.vsync_.mutatePromise(() => {
      this.containerEmpty_ = true;
      this.innerContainer_ = null;
      removeChildren(this.getContainer_());
    });
  }

  /**
   * @private
   */
  renderPurchaseOverlay_() {
    const dialogContainer = this.getContainer_();
    this.innerContainer_ = this.createElement_('div');
    this.innerContainer_.className = TAG + '-container';

    const leftContainer = this.createElement_('div');
    leftContainer.className = TAG + '-left-container';

    const leftLogo = this.createElement_('div');
    leftLogo.className = TAG + '-left-logo-container';
    leftContainer.appendChild(leftLogo);

    const rightContainer = this.createElement_('div');
    rightContainer.className = TAG + '-right-container';

    const logoContainer = this.createElement_('div');
    logoContainer.className = TAG + '-logo-container';
    const fcLogoContainer = this.createElement_('div');
    fcLogoContainer.className = TAG + '-fc-logo-container';
    fcLogoContainer.textContent = 'Few¢ents';
    logoContainer.appendChild(fcLogoContainer);

    rightContainer.appendChild(logoContainer);

    const description = this.createElement_('div');
    description.className = TAG + '-description-container';
    description.textContent = 'Get access to premium content now!';

    const subDescription = this.createElement_('div');
    subDescription.className = TAG + '-subDescription-container';
    subDescription.textContent = 'One login. Many publishers. No subscription.';

    const price = this.createElement_('div');
    price.className = TAG + '-price';
    price.textContent = `${new Intl.NumberFormat('en-EN', { style: 'currency', currency: this.purchaseConfig_?.purchase_options?.price?.currency }).format(this.purchaseConfig_?.purchase_options?.price?.amount)}/article`;

    rightContainer.appendChild(description);
    rightContainer.appendChild(subDescription);
    rightContainer.appendChild(price);

    this.innerContainer_.appendChild(leftContainer);
    this.innerContainer_.appendChild(rightContainer);

    const purchaseButton = this.createElement_('button');
    purchaseButton.className = TAG + '-purchase-button primary';
    purchaseButton.textContent = this.i18n_['defaultButton'];
    this.purchaseButton_ = purchaseButton;
    this.purchaseButtonListener_ = listen(purchaseButton, 'click', (ev) => {
      this.handlePurchase_(
        ev,
        this.purchaseConfig_.purchase_options.purchase_url
      );
    });

    const buttonsContainer = this.createElement_('div');
    buttonsContainer.className = TAG + '-buttons-container';
    buttonsContainer.appendChild(purchaseButton);
    buttonsContainer.appendChild(
      this.createAlreadyPurchasedLink_(this.purchaseConfig_['identify_url'])
    );

    rightContainer.appendChild(buttonsContainer);

    dialogContainer.appendChild(this.innerContainer_);
    this.containerEmpty_ = false;
  }

  /**
   * @return {!Element}
   */
  renderContainer() {
    const dialogContainer = this.getContainer_();
    const element = this.createElement_('div');

    element.className = TAG + '-container';

    return dialogContainer;
  }

  /**
   * @param {!JsonObject} option Shape: PurchaseOption_0_2_Def
   * @return {!Element}
   * @private
   */

  /**
   * @param {string} href
   * @return {!Element}
   */
  createAlreadyPurchasedLink_(href) {
    const button = this.createElement_('button');
    button.className = TAG + '-purchase-button';

    button.textContent = this.i18n_['alreadyPurchasedLink'];
    this.alreadyPurchasedListener_ = listen(button, 'click', (ev) => {
      this.handlePurchase_(ev, href, 'alreadyPurchased');
    });

    return button;
  }

  /**
   * @param {!Event} ev
   * @param {string} purchaseUrl
   * @private
   */
  handlePurchase_(ev, purchaseUrl) {
    ev.preventDefault();
    const urlPromise = this.accessSource_.buildUrl(
      purchaseUrl,
      /* useAuthData */ false
    );
    return urlPromise.then((url) => {
      dev().fine(TAG, 'Authorization URL: ', url);
      this.accessSource_.loginWithUrl(url);
    });
  }

  /**
   * @return {!Promise}
   */
  pingback() {
    return Promise.resolve();
  }
}
