/**
 * Note View Component - Display informational notes
 */

import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { t } from "../i18n/index.js";
import { translateBackendMessage } from "../i18n/backend-messages.js";
import { LocalizedElement } from "../components/localized-element.js";

@customElement("onboard-note")
export class OnboardNote extends LocalizedElement {
  static override styles = css`
    :host {
      display: block;
    }

    .note-container {
      max-width: 900px;
      margin: 0 auto;
      padding: 2rem;
    }

    .note-box {
      background: var(--color-bg-secondary, #f8f9fa);
      border: 1px solid var(--color-border, #dee2e6);
      border-left: 4px solid var(--color-info, #457b9d);
      border-radius: 0.5rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      max-height: 60vh;
      overflow-y: auto;
    }

    .note-title {
      font-size: 1.125rem;
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--color-text, #212529);
    }

    .note-content {
      white-space: pre-line;
      color: var(--color-text-secondary, #6c757d);
      line-height: 1.6;
    }

    .note-content.two-column {
      column-count: 2;
      column-gap: 2rem;
    }

    @media (max-width: 768px) {
      .note-content.two-column {
        column-count: 1;
      }
    }

    .button-group {
      display: flex;
      justify-content: center;
    }

    .btn {
      padding: 0.625rem 1.5rem;
      font-size: 1rem;
      font-family: inherit;
      background: var(--color-primary, #e63946);
      color: white;
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      transition: all 150ms ease;
    }

    .btn:hover {
      background: var(--color-primary-hover, #c1121f);
    }
  `;

  @property({ type: String }) message = "";
  @property({ type: String }) title?: string;

  private handleContinue(): void {
    this.dispatchEvent(new CustomEvent("continue"));
  }

  private isLongContent(): boolean {
    // Check if content has many lines (like channel status)
    const lines = this.message.split("\n").length;
    return lines > 10;
  }

  override render() {
    const translatedTitle = this.title ? translateBackendMessage(this.title) : undefined;
    const translatedMessage = translateBackendMessage(this.message);
    const useTwoColumn = this.isLongContent();

    return html`
      <div class="note-container">
        <div class="note-box">
          ${translatedTitle ? html`<div class="note-title">${translatedTitle}</div>` : ""}
          <div class="note-content ${useTwoColumn ? "two-column" : ""}">${translatedMessage}</div>
        </div>
        
        <div class="button-group">
          <button class="btn" @click=${this.handleContinue}>
            ${t("common.continue")}
          </button>
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "onboard-note": OnboardNote;
  }
}
