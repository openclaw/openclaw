/**
 * Security Notice View Component
 */

import { html, css } from "lit";
import { customElement } from "lit/decorators.js";
import { t } from "../i18n/index.js";
import { LocalizedElement } from "../components/localized-element.js";

@customElement("onboard-security")
export class OnboardSecurity extends LocalizedElement {
  static override styles = css`
    :host {
      display: block;
    }

    .security-container {
      max-width: 700px;
      margin: 0 auto;
      padding: 2rem;
    }

    .header {
      text-align: center;
      margin-bottom: 2rem;
    }

    .icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }

    .title {
      font-size: 1.75rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: var(--color-text, #212529);
    }

    .warning-box {
      background: rgba(230, 57, 70, 0.1);
      border: 1px solid var(--color-error, #e63946);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }

    .warning-title {
      font-weight: 600;
      color: var(--color-error, #e63946);
      margin-bottom: 0.75rem;
    }

    .warning-text {
      white-space: pre-line;
      color: var(--color-text-secondary, #6c757d);
      line-height: 1.6;
    }

    .recommendations-box {
      background: var(--color-bg-secondary, #f8f9fa);
      border: 1px solid var(--color-border, #dee2e6);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 2rem;
    }

    .recommendations-title {
      font-weight: 600;
      margin-bottom: 0.75rem;
    }

    .recommendations-text {
      white-space: pre-line;
      color: var(--color-text-secondary, #6c757d);
      line-height: 1.6;
    }

    .docs-link {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      color: var(--color-info, #457b9d);
      text-decoration: none;
      margin-bottom: 2rem;
    }

    .docs-link:hover {
      text-decoration: underline;
    }

    .button-group {
      display: flex;
      gap: 1rem;
      justify-content: center;
    }

    .btn {
      padding: 0.75rem 1.5rem;
      font-size: 1rem;
      font-family: inherit;
      border-radius: 0.5rem;
      cursor: pointer;
      transition: all 150ms ease;
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

  private handleAccept(): void {
    this.dispatchEvent(new CustomEvent("accept", { detail: { accepted: true } }));
  }

  private handleDecline(): void {
    this.dispatchEvent(new CustomEvent("decline", { detail: { accepted: false } }));
  }

  override render() {
    return html`
      <div class="security-container">
        <div class="header">
          <div class="icon">🔒</div>
          <h2 class="title">${t("security.title")}</h2>
        </div>

        <div class="warning-box">
          <div class="warning-title">${t("security.warning")}</div>
          <div class="warning-text">${t("security.description")}</div>
        </div>

        <div class="recommendations-box">
          <div class="recommendations-title">${t("security.recommendations")}</div>
          <div class="recommendations-text">${t("security.recommendations")}</div>
        </div>

        <a href="https://docs.openclaw.ai/gateway/security" target="_blank" class="docs-link">
          📚 ${t("security.docs")} →
        </a>

        <div class="button-group">
          <button class="btn btn-secondary" @click=${this.handleDecline}>
            ${t("security.decline")}
          </button>
          <button class="btn btn-primary" @click=${this.handleAccept}>
            ${t("security.accept")}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "onboard-security": OnboardSecurity;
  }
}
