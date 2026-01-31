/**
 * Language Switcher Component
 */

import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getLocale, setLocale, type Locale } from "../i18n/index.js";

@customElement("language-switcher")
export class LanguageSwitcher extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      top: 1rem;
      right: 1rem;
      z-index: 1000;
    }

    .switcher {
      display: flex;
      gap: 0.25rem;
      background: var(--color-bg-secondary, #f8f9fa);
      padding: 0.25rem;
      border-radius: 0.5rem;
      border: 1px solid var(--color-border, #dee2e6);
    }

    .lang-btn {
      padding: 0.375rem 0.75rem;
      font-size: 0.875rem;
      font-family: inherit;
      background: transparent;
      border: none;
      border-radius: 0.375rem;
      cursor: pointer;
      transition: all 150ms ease;
      color: var(--color-text-secondary, #6c757d);
    }

    .lang-btn:hover {
      background: var(--color-bg-tertiary, #e9ecef);
    }

    .lang-btn.active {
      background: var(--color-primary, #e63946);
      color: white;
    }
  `;

  @state() private currentLocale: Locale = getLocale();

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("locale-changed", this.handleLocaleChange);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("locale-changed", this.handleLocaleChange);
  }

  private handleLocaleChange = (event: Event): void => {
    const customEvent = event as CustomEvent<{ locale: Locale }>;
    this.currentLocale = customEvent.detail.locale;
  };

  private switchLocale(locale: Locale): void {
    if (locale !== this.currentLocale) {
      setLocale(locale);
    }
  }

  override render() {
    return html`
      <div class="switcher">
        <button
          class="lang-btn ${this.currentLocale === "en" ? "active" : ""}"
          @click=${() => this.switchLocale("en")}
        >
          EN
        </button>
        <button
          class="lang-btn ${this.currentLocale === "zh" ? "active" : ""}"
          @click=${() => this.switchLocale("zh")}
        >
          中文
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "language-switcher": LanguageSwitcher;
  }
}
