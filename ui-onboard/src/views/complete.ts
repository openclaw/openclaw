/**
 * Complete View Component - Final success screen
 */

import { html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { t } from "../i18n/index.js";
import { LocalizedElement } from "../components/localized-element.js";
import { onboardSocket } from "../services/websocket.js";

@customElement("onboard-complete")
export class OnboardComplete extends LocalizedElement {
  static override styles = css`
    :host {
      display: block;
    }

    .complete-container {
      max-width: 600px;
      margin: 0 auto;
      padding: 2rem;
      text-align: center;
    }

    .icon {
      font-size: 5rem;
      margin-bottom: 1.5rem;
    }

    .title {
      font-size: 2rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      color: var(--color-text, #212529);
    }

    .subtitle {
      font-size: 1.125rem;
      color: var(--color-text-secondary, #6c757d);
      margin-bottom: 2rem;
    }

    .message {
      color: var(--color-text-secondary, #6c757d);
      margin-bottom: 2rem;
      line-height: 1.6;
    }

    .next-steps {
      background: var(--color-bg-secondary, #f8f9fa);
      border: 1px solid var(--color-border, #dee2e6);
      border-radius: 0.75rem;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
      text-align: left;
    }

    .next-steps-title {
      font-weight: 600;
      margin-bottom: 1rem;
      color: var(--color-text, #212529);
    }

    .step-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .step-item {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.5rem 0;
      color: var(--color-text-secondary, #6c757d);
    }

    .step-number {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: var(--color-primary, #e63946);
      color: white;
      border-radius: 50%;
      font-size: 0.75rem;
      font-weight: 600;
      flex-shrink: 0;
    }

    .step-text code {
      background: var(--color-bg-tertiary, #e9ecef);
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      font-family: var(--font-family-mono, monospace);
      font-size: 0.875rem;
    }

    .info-box {
      background: var(--color-bg-info, #e7f5ff);
      border: 1px solid var(--color-info, #457b9d);
      border-radius: 0.75rem;
      padding: 1.25rem;
      margin-bottom: 1.5rem;
      text-align: left;
    }

    .info-box-title {
      font-weight: 600;
      margin-bottom: 0.75rem;
      color: var(--color-info, #457b9d);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .info-box-content {
      color: var(--color-text-secondary, #6c757d);
      font-size: 0.9rem;
      line-height: 1.6;
    }

    .info-box-content code {
      background: rgba(69, 123, 157, 0.15);
      padding: 0.125rem 0.375rem;
      border-radius: 0.25rem;
      font-family: var(--font-family-mono, monospace);
      font-size: 0.85rem;
      color: var(--color-info, #457b9d);
    }

    .command-box {
      background: #1e1e1e;
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
      margin: 0.75rem 0;
      font-family: var(--font-family-mono, monospace);
      font-size: 0.9rem;
      color: #d4d4d4;
      overflow-x: auto;
    }

    .warning-box {
      background: var(--color-bg-warning, #fff3cd);
      border: 1px solid var(--color-warning, #ffc107);
      border-radius: 0.75rem;
      padding: 1rem;
      margin-bottom: 1.5rem;
      text-align: left;
    }

    .warning-box-title {
      font-weight: 600;
      margin-bottom: 0.5rem;
      color: var(--color-warning-dark, #856404);
    }

    .warning-box-content {
      color: var(--color-text-secondary, #6c757d);
      font-size: 0.9rem;
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

    .btn-danger {
      background: var(--color-error, #dc3545);
      color: white;
      border: none;
    }

    .btn-danger:hover {
      background: #c82333;
    }

    .btn-danger:disabled {
      background: #6c757d;
      cursor: not-allowed;
    }

    .shutdown-section {
      margin-top: 2rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--color-border, #dee2e6);
    }

    .shutdown-description {
      color: var(--color-text-secondary, #6c757d);
      font-size: 0.9rem;
      margin-bottom: 1rem;
    }

    .shutdown-status {
      color: var(--color-success, #28a745);
      font-size: 0.9rem;
      margin-top: 0.5rem;
    }
  `;

  @property({ type: String }) message = "";
  @state() private isShuttingDown = false;
  @state() private shutdownComplete = false;

  override connectedCallback(): void {
    super.connectedCallback();
    // Listen for shutdown acknowledgement
    onboardSocket.onShutdownAck(() => {
      this.shutdownComplete = true;
      // Close the browser tab/window after a short delay
      setTimeout(() => {
        window.close();
        // If window.close() doesn't work (e.g., not opened by script), show a message
      }, 500);
    });
  }

  private handleClose(): void {
    this.dispatchEvent(new CustomEvent("close"));
  }

  private handleShutdown(): void {
    this.isShuttingDown = true;
    onboardSocket.requestShutdown();
  }

  private openDashboard(): void {
    window.open("http://127.0.0.1:18789", "_blank");
  }

  override render() {
    return html`
      <div class="complete-container">
        <div class="icon">🎉</div>
        <h1 class="title">${t("complete.title")}</h1>
        <p class="subtitle">${t("complete.subtitle")}</p>
        
        ${this.message ? html`<p class="message">${this.message}</p>` : ""}

        <div class="info-box">
          <div class="info-box-title">
            <span>💡</span>
            <span>${t("complete.gateway_info_title")}</span>
          </div>
          <div class="info-box-content">
            <p>${t("complete.gateway_info_desc")}</p>
            <div class="command-box">openclaw gateway run</div>
            <p>${t("complete.gateway_info_note")}</p>
          </div>
        </div>

        <div class="next-steps">
          <div class="next-steps-title">${t("complete.next_steps")}</div>
          <ol class="step-list">
            <li class="step-item">
              <span class="step-number">1</span>
              <span class="step-text">${t("complete.step1")}</span>
            </li>
            <li class="step-item">
              <span class="step-number">2</span>
              <span class="step-text">${t("complete.step2")}</span>
            </li>
            <li class="step-item">
              <span class="step-number">3</span>
              <span class="step-text">${t("complete.step3")}</span>
            </li>
          </ol>
        </div>

        <div class="warning-box">
          <div class="warning-box-title">⚠️ ${t("complete.service_warning_title")}</div>
          <div class="warning-box-content">
            ${t("complete.service_warning_desc")}
          </div>
        </div>

        <div class="button-group">
          <button class="btn btn-primary" @click=${this.openDashboard}>
            ${t("complete.open_dashboard")}
          </button>
        </div>

        <div class="shutdown-section">
          <p class="shutdown-description">${t("complete.shutdown_description")}</p>
          <button 
            class="btn btn-danger" 
            @click=${this.handleShutdown}
            ?disabled=${this.isShuttingDown || this.shutdownComplete}
          >
            ${this.shutdownComplete 
              ? t("complete.shutdown_complete") 
              : this.isShuttingDown 
                ? t("complete.shutting_down") 
                : t("complete.shutdown_wizard")}
          </button>
          ${this.shutdownComplete ? html`
            <p class="shutdown-status">${t("complete.shutdown_status")}</p>
          ` : ""}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "onboard-complete": OnboardComplete;
  }
}
