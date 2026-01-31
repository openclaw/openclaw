/**
 * Confirm View Component - Yes/No confirmation
 */

import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { t } from "../i18n/index.js";
import { translateBackendMessage } from "../i18n/backend-messages.js";
import { LocalizedElement } from "../components/localized-element.js";

@customElement("onboard-confirm")
export class OnboardConfirm extends LocalizedElement {
  static override styles = css`
    :host {
      display: block;
    }

    .confirm-container {
      max-width: 500px;
      margin: 0 auto;
      padding: 2rem;
      text-align: center;
    }

    .message {
      font-size: 1.25rem;
      font-weight: 500;
      margin-bottom: 2rem;
      color: var(--color-text, #212529);
      line-height: 1.5;
    }

    .button-group {
      display: flex;
      gap: 1rem;
      justify-content: center;
    }

    .btn {
      padding: 0.75rem 2rem;
      font-size: 1rem;
      font-family: inherit;
      border-radius: 0.5rem;
      cursor: pointer;
      transition: all 150ms ease;
      min-width: 100px;
    }

    .btn-primary {
      background: var(--color-primary, #e63946);
      color: white;
      border: none;
    }

    .btn-primary:hover {
      background: var(--color-primary-hover, #c1121f);
    }

    .btn-secondary {
      background: transparent;
      color: var(--color-text, #212529);
      border: 1px solid var(--color-border, #dee2e6);
    }

    .btn-secondary:hover {
      background: var(--color-bg-tertiary, #e9ecef);
    }
  `;

  @property({ type: String }) message = "";
  @property({ type: Boolean }) initialValue = false;

  private handleConfirm(value: boolean): void {
    this.dispatchEvent(new CustomEvent("confirm", { detail: { value } }));
  }

  override render() {
    const translatedMessage = translateBackendMessage(this.message);

    return html`
      <div class="confirm-container">
        <div class="message">${translatedMessage}</div>
        
        <div class="button-group">
          <button class="btn btn-secondary" @click=${() => this.handleConfirm(false)}>
            ${t("common.no")}
          </button>
          <button class="btn btn-primary" @click=${() => this.handleConfirm(true)}>
            ${t("common.yes")}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "onboard-confirm": OnboardConfirm;
  }
}
