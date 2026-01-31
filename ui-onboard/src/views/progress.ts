/**
 * Progress View Component - Show loading/progress state
 */

import { html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import { translateBackendMessage } from "../i18n/backend-messages.js";
import { LocalizedElement } from "../components/localized-element.js";

@customElement("onboard-progress")
export class OnboardProgress extends LocalizedElement {
  static override styles = css`
    :host {
      display: block;
    }

    .progress-container {
      max-width: 400px;
      margin: 0 auto;
      padding: 2rem;
      text-align: center;
    }

    .spinner {
      display: inline-block;
      width: 48px;
      height: 48px;
      border: 4px solid var(--color-border, #dee2e6);
      border-top-color: var(--color-primary, #e63946);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 1.5rem;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .label {
      font-size: 1.125rem;
      color: var(--color-text-secondary, #6c757d);
    }

    .completed {
      color: var(--color-success, #2a9d8f);
    }

    .completed .spinner {
      border-color: var(--color-success, #2a9d8f);
      border-top-color: transparent;
      animation: none;
    }

    .check-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }
  `;

  @property({ type: String }) label = "";
  @property({ type: String }) status: "start" | "update" | "stop" = "start";

  override render() {
    const isComplete = this.status === "stop";
    const translatedLabel = translateBackendMessage(this.label);

    return html`
      <div class="progress-container ${isComplete ? "completed" : ""}">
        ${isComplete 
          ? html`<div class="check-icon">✓</div>` 
          : html`<div class="spinner"></div>`
        }
        <div class="label">${translatedLabel}</div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "onboard-progress": OnboardProgress;
  }
}
