/**
 * Text Input View Component
 */

import { html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { t } from "../i18n/index.js";
import { translateBackendMessage } from "../i18n/backend-messages.js";
import { LocalizedElement } from "../components/localized-element.js";

@customElement("onboard-text-input")
export class OnboardTextInput extends LocalizedElement {
  static override styles = css`
    :host {
      display: block;
    }

    .text-input-container {
      max-width: 500px;
      margin: 0 auto;
      padding: 2rem;
    }

    .message {
      font-size: 1.25rem;
      font-weight: 500;
      margin-bottom: 1.5rem;
      color: var(--color-text, #212529);
    }

    .input-wrapper {
      margin-bottom: 1.5rem;
    }

    .text-input {
      width: 100%;
      padding: 0.75rem 1rem;
      font-size: 1rem;
      font-family: inherit;
      color: var(--color-text, #212529);
      background: var(--color-bg, #ffffff);
      border: 2px solid var(--color-border, #dee2e6);
      border-radius: 0.5rem;
      transition: border-color 150ms ease;
      box-sizing: border-box;
    }

    .text-input:focus {
      outline: none;
      border-color: var(--color-primary, #e63946);
    }

    .text-input::placeholder {
      color: var(--color-text-muted, #adb5bd);
    }

    .text-input.password {
      font-family: monospace;
      letter-spacing: 0.1em;
    }

    .hint {
      font-size: 0.875rem;
      color: var(--color-text-secondary, #6c757d);
      margin-top: 0.5rem;
    }

    .button-group {
      display: flex;
      gap: 1rem;
      justify-content: flex-end;
    }

    .btn {
      padding: 0.625rem 1.25rem;
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

    .btn-primary:hover:not(:disabled) {
      background: var(--color-primary-hover, #c1121f);
    }

    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  `;

  @property({ type: String }) message = "";
  @property({ type: String }) initialValue?: string;
  @property({ type: String }) placeholder?: string;

  @state() private value = "";

  override connectedCallback(): void {
    super.connectedCallback();
    this.value = this.initialValue ?? "";
  }

  private handleInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    this.value = input.value;
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && (this.value ?? "").trim()) {
      this.handleSubmit();
    }
  }

  private handleSubmit(): void {
    this.dispatchEvent(new CustomEvent("submit", { detail: { value: this.value } }));
  }

  private isPasswordField(): boolean {
    const msg = this.message.toLowerCase();
    return msg.includes("api key") || 
           msg.includes("密钥") || 
           msg.includes("password") || 
           msg.includes("token") ||
           msg.includes("secret");
  }

  override render() {
    const isPassword = this.isPasswordField();
    const translatedMessage = translateBackendMessage(this.message);

    return html`
      <div class="text-input-container">
        <div class="message">${translatedMessage}</div>
        
        <div class="input-wrapper">
          <input
            type="${isPassword ? "password" : "text"}"
            class="text-input ${isPassword ? "password" : ""}"
            .value=${this.value}
            placeholder=${this.placeholder || ""}
            @input=${this.handleInput}
            @keydown=${this.handleKeydown}
            autocomplete="off"
          />
          ${isPassword ? html`
            <div class="hint">${t("auth.api_key.hint")}</div>
          ` : ""}
        </div>

        <div class="button-group">
          <button 
            class="btn btn-primary" 
            @click=${this.handleSubmit}
            ?disabled=${!(this.value ?? "").trim()}
          >
            ${t("common.continue")}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "onboard-text-input": OnboardTextInput;
  }
}
