/**
 * Welcome View Component
 */

import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { t } from "../i18n/index.js";
import { LocalizedElement } from "../components/localized-element.js";

@customElement("onboard-welcome")
export class OnboardWelcome extends LocalizedElement {
  static override styles = css`
    :host {
      display: block;
    }

    .welcome-container {
      text-align: center;
      max-width: 600px;
      margin: 0 auto;
      padding: 2rem;
    }

    .logo {
      font-size: 5rem;
      margin-bottom: 1.5rem;
    }

    .title {
      font-size: 2.5rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      color: var(--color-text, #212529);
    }

    .subtitle {
      font-size: 1.25rem;
      color: var(--color-text-secondary, #6c757d);
      margin-bottom: 2rem;
    }

    .description {
      color: var(--color-text-secondary, #6c757d);
      margin-bottom: 2rem;
      line-height: 1.6;
    }

    .start-button {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 2rem;
      font-size: 1.125rem;
      font-weight: 500;
      font-family: inherit;
      background: var(--color-primary, #e63946);
      color: white;
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      transition: all 150ms ease;
    }

    .start-button:hover {
      background: var(--color-primary-hover, #c1121f);
      transform: translateY(-1px);
    }

    .start-button:active {
      transform: translateY(0);
    }
  `;

  @property({ type: String }) title = "";

  private handleContinue(): void {
    this.dispatchEvent(new CustomEvent("continue"));
  }

  override render() {
    return html`
      <div class="welcome-container">
        <div class="logo">🦞</div>
        <h1 class="title">${t("welcome.title")}</h1>
        <p class="subtitle">${t("welcome.subtitle")}</p>
        <p class="description">${t("welcome.description")}</p>
        <button class="start-button" @click=${this.handleContinue}>
          ${t("welcome.start")} →
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "onboard-welcome": OnboardWelcome;
  }
}
