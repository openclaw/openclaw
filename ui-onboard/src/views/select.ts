/**
 * Select View Component - Single selection from options
 */

import { html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { t } from "../i18n/index.js";
import { translateBackendMessage, translateOptionLabel, translateHint } from "../i18n/backend-messages.js";
import { LocalizedElement } from "../components/localized-element.js";

interface SelectOption {
  value: unknown;
  label: string;
  hint?: string;
}

@customElement("onboard-select")
export class OnboardSelect extends LocalizedElement {
  static override styles = css`
    :host {
      display: block;
    }

    .select-container {
      max-width: 900px;
      margin: 0 auto;
      padding: 2rem;
    }

    .select-container.two-column {
      max-width: 900px;
    }

    .message {
      font-size: 1.25rem;
      font-weight: 500;
      margin-bottom: 1.5rem;
      color: var(--color-text, #212529);
    }

    .option-list {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .option-list.two-column {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.75rem;
    }

    @media (max-width: 768px) {
      .option-list.two-column {
        grid-template-columns: 1fr;
      }
    }

    .option-item {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem;
      background: var(--color-bg, #ffffff);
      border: 2px solid var(--color-border, #dee2e6);
      border-radius: 0.5rem;
      cursor: pointer;
      transition: all 150ms ease;
    }

    .option-item:hover {
      border-color: var(--color-primary, #e63946);
      background: rgba(230, 57, 70, 0.05);
    }

    .option-item.selected {
      border-color: var(--color-primary, #e63946);
      background: rgba(230, 57, 70, 0.1);
    }

    .option-radio {
      width: 20px;
      height: 20px;
      border: 2px solid var(--color-border, #dee2e6);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .option-item.selected .option-radio {
      border-color: var(--color-primary, #e63946);
    }

    .option-radio-inner {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--color-primary, #e63946);
      opacity: 0;
      transition: opacity 150ms ease;
    }

    .option-item.selected .option-radio-inner {
      opacity: 1;
    }

    .option-content {
      flex: 1;
    }

    .option-label {
      font-weight: 500;
      color: var(--color-text, #212529);
    }

    .option-hint {
      font-size: 0.875rem;
      color: var(--color-text-secondary, #6c757d);
      margin-top: 0.25rem;
    }

    .button-group {
      display: flex;
      gap: 1rem;
      margin-top: 1.5rem;
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
  @property({ type: Array }) options: SelectOption[] = [];
  @property({ attribute: false }) initialValue: unknown = undefined;

  @state() private selectedValue: unknown = undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.selectedValue = this.initialValue;
  }

  private handleSelect(value: unknown): void {
    this.selectedValue = value;
    // Immediately submit on selection for better UX
    this.dispatchEvent(new CustomEvent("select", { detail: { value } }));
  }

  override render() {
    const translatedMessage = translateBackendMessage(this.message);
    const useTwoColumn = this.options.length > 6;

    return html`
      <div class="select-container ${useTwoColumn ? "two-column" : ""}">
        <div class="message">${translatedMessage}</div>
        
        <div class="option-list ${useTwoColumn ? "two-column" : ""}">
          ${this.options.map((option) => {
            const translatedLabel = translateOptionLabel(option.label);
            const translatedHint = option.hint ? translateHint(option.hint) : undefined;
            return html`
              <div
                class="option-item ${this.selectedValue === option.value ? "selected" : ""}"
                @click=${() => this.handleSelect(option.value)}
              >
                <div class="option-radio">
                  <div class="option-radio-inner"></div>
                </div>
                <div class="option-content">
                  <div class="option-label">${translatedLabel}</div>
                  ${translatedHint ? html`<div class="option-hint">${translatedHint}</div>` : ""}
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "onboard-select": OnboardSelect;
  }
}
