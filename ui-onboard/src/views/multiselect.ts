/**
 * Multiselect View Component - Multiple selection from options
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

@customElement("onboard-multiselect")
export class OnboardMultiselect extends LocalizedElement {
  static override styles = css`
    :host {
      display: block;
    }

    .multiselect-container {
      max-width: 600px;
      margin: 0 auto;
      padding: 2rem;
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

    .option-checkbox {
      width: 20px;
      height: 20px;
      border: 2px solid var(--color-border, #dee2e6);
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .option-item.selected .option-checkbox {
      border-color: var(--color-primary, #e63946);
      background: var(--color-primary, #e63946);
    }

    .checkmark {
      color: white;
      font-size: 14px;
      opacity: 0;
    }

    .option-item.selected .checkmark {
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
  @property({ type: Array }) options: SelectOption[] = [];
  @property({ type: Array }) initialValues: unknown[] = [];

  @state() private selectedValues: Set<unknown> = new Set();

  override connectedCallback(): void {
    super.connectedCallback();
    this.selectedValues = new Set(this.initialValues);
  }

  private toggleOption(value: unknown): void {
    const newSet = new Set(this.selectedValues);
    if (newSet.has(value)) {
      newSet.delete(value);
    } else {
      newSet.add(value);
    }
    this.selectedValues = newSet;
  }

  private handleSubmit(): void {
    this.dispatchEvent(new CustomEvent("select", { 
      detail: { values: Array.from(this.selectedValues) } 
    }));
  }

  override render() {
    const translatedMessage = translateBackendMessage(this.message);

    return html`
      <div class="multiselect-container">
        <div class="message">${translatedMessage}</div>
        
        <div class="option-list">
          ${this.options.map((option) => {
            const translatedLabel = translateOptionLabel(option.label);
            const translatedHint = option.hint ? translateHint(option.hint) : undefined;
            return html`
              <div
                class="option-item ${this.selectedValues.has(option.value) ? "selected" : ""}"
                @click=${() => this.toggleOption(option.value)}
              >
                <div class="option-checkbox">
                  <span class="checkmark">✓</span>
                </div>
                <div class="option-content">
                  <div class="option-label">${translatedLabel}</div>
                  ${translatedHint ? html`<div class="option-hint">${translatedHint}</div>` : ""}
                </div>
              </div>
            `;
          })}
        </div>

        <div class="button-group">
          <button class="btn btn-primary" @click=${this.handleSubmit}>
            ${t("common.continue")}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "onboard-multiselect": OnboardMultiselect;
  }
}
