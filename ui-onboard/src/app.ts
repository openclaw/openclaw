/**
 * OpenClaw Onboarding App - Main Component
 */

import { LitElement, html, css, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { t, getLocale, setLocale, type Locale } from "./i18n/index.js";
import { onboardSocket, type PromptMessage, type CompleteMessage } from "./services/websocket.js";

// Import views
import "./views/welcome.js";
import "./views/security.js";
import "./views/select.js";
import "./views/multiselect.js";
import "./views/text-input.js";
import "./views/confirm.js";
import "./views/note.js";
import "./views/progress.js";
import "./views/complete.js";
import "./components/language-switcher.js";

type ViewState = "connecting" | "prompt" | "complete" | "error";

@customElement("onboard-app")
export class OnboardApp extends LitElement {
  static override styles = css`
    :host {
      display: block;
      min-height: 100vh;
    }

    .app-container {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 2rem;
    }

    .loading-container {
      text-align: center;
    }

    .spinner {
      display: inline-block;
      width: 40px;
      height: 40px;
      border: 3px solid var(--color-border, #dee2e6);
      border-top-color: var(--color-primary, #e63946);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .loading-text {
      margin-top: 1rem;
      color: var(--color-text-secondary, #6c757d);
    }

    .error-container {
      text-align: center;
      padding: 2rem;
    }

    .error-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
    }

    .error-message {
      color: var(--color-error, #e63946);
      margin-bottom: 1rem;
    }

    .retry-button {
      padding: 0.5rem 1.5rem;
      background: var(--color-primary, #e63946);
      color: white;
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 1rem;
    }

    .retry-button:hover {
      background: var(--color-primary-hover, #c1121f);
    }

    .prompt-container {
      width: 100%;
      max-width: 800px;
    }

    .complete-message {
      text-align: center;
      padding: 2rem;
    }

    .complete-icon {
      font-size: 4rem;
      margin-bottom: 1rem;
    }

    .complete-title {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }

    .complete-text {
      color: var(--color-text-secondary, #6c757d);
      margin-bottom: 1.5rem;
      max-width: 400px;
    }

    .complete-message .retry-button {
      margin-top: 1rem;
    }
  `;

  @state() private viewState: ViewState = "connecting";
  @state() private currentPrompt: PromptMessage | null = null;
  @state() private completeMessage: CompleteMessage | null = null;
  @state() private locale: Locale = getLocale();

  override connectedCallback(): void {
    super.connectedCallback();
    
    // Listen for locale changes
    window.addEventListener("locale-changed", this.handleLocaleChange);
    
    // Setup WebSocket handlers
    onboardSocket.onConnect(() => {
      this.viewState = "prompt";
    });

    onboardSocket.onDisconnect(() => {
      if (this.viewState !== "complete") {
        this.viewState = "error";
      }
    });

    onboardSocket.onMessage((message) => {
      this.currentPrompt = message;
      this.viewState = "prompt";
    });

    onboardSocket.onComplete((message) => {
      this.completeMessage = message;
      this.viewState = "complete";
    });

    // Connect to server
    onboardSocket.connect();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener("locale-changed", this.handleLocaleChange);
    onboardSocket.disconnect();
  }

  private handleLocaleChange = (event: Event): void => {
    const customEvent = event as CustomEvent<{ locale: Locale }>;
    this.locale = customEvent.detail.locale;
    this.requestUpdate();
  };

  private handleResponse(value: unknown): void {
    if (this.currentPrompt) {
      onboardSocket.sendResponse(this.currentPrompt.id, value);
      this.currentPrompt = null;
    }
  }

  private handleCancel(): void {
    if (this.currentPrompt) {
      onboardSocket.sendResponse(this.currentPrompt.id, null, true);
      this.currentPrompt = null;
    }
  }

  private handleRetry(): void {
    this.viewState = "connecting";
    onboardSocket.connect();
  }

  override render(): TemplateResult {
    return html`
      <div class="app-container">
        <language-switcher></language-switcher>
        <main class="main-content">
          ${this.renderContent()}
        </main>
      </div>
    `;
  }

  private renderContent(): TemplateResult {
    switch (this.viewState) {
      case "connecting":
        return this.renderConnecting();
      case "prompt":
        return this.renderPrompt();
      case "complete":
        return this.renderComplete();
      case "error":
        return this.renderError();
    }
  }

  private renderConnecting(): TemplateResult {
    return html`
      <div class="loading-container">
        <div class="spinner"></div>
        <p class="loading-text">${t("app.connecting")}</p>
      </div>
    `;
  }

  private renderPrompt(): TemplateResult {
    if (!this.currentPrompt) {
      return html`
        <div class="loading-container">
          <div class="spinner"></div>
          <p class="loading-text">${t("app.loading")}</p>
        </div>
      `;
    }

    const params = this.currentPrompt.params as Record<string, unknown>;

    return html`
      <div class="prompt-container">
        ${this.renderPromptByType(this.currentPrompt.type, params)}
      </div>
    `;
  }

  private renderPromptByType(type: string, params: Record<string, unknown>): TemplateResult {
    switch (type) {
      case "intro":
        return html`
          <onboard-welcome
            .title=${params.title as string}
            @continue=${() => this.handleResponse(true)}
          ></onboard-welcome>
        `;
      
      case "note":
        return html`
          <onboard-note
            .message=${params.message as string}
            .title=${params.title as string | undefined}
            @continue=${() => this.handleResponse(true)}
          ></onboard-note>
        `;
      
      case "confirm":
        return html`
          <onboard-confirm
            .message=${params.message as string}
            .initialValue=${params.initialValue as boolean | undefined}
            @confirm=${(e: CustomEvent) => this.handleResponse(e.detail.value)}
          ></onboard-confirm>
        `;
      
      case "select":
        return html`
          <onboard-select
            .message=${params.message as string}
            .options=${params.options as Array<{ value: unknown; label: string; hint?: string }>}
            .initialValue=${params.initialValue}
            @select=${(e: CustomEvent) => this.handleResponse(e.detail.value)}
          ></onboard-select>
        `;
      
      case "multiselect":
        return html`
          <onboard-multiselect
            .message=${params.message as string}
            .options=${params.options as Array<{ value: unknown; label: string; hint?: string }>}
            .initialValues=${params.initialValues as unknown[] | undefined}
            @select=${(e: CustomEvent) => this.handleResponse(e.detail.values)}
          ></onboard-multiselect>
        `;
      
      case "text":
        return html`
          <onboard-text-input
            .message=${params.message as string}
            .initialValue=${params.initialValue as string | undefined}
            .placeholder=${params.placeholder as string | undefined}
            @submit=${(e: CustomEvent) => this.handleResponse(e.detail.value)}
          ></onboard-text-input>
        `;
      
      case "progress":
        return html`
          <onboard-progress
            .label=${(params as { label: string }).label}
            .status=${(params as { status: string }).status}
          ></onboard-progress>
        `;
      
      case "outro":
        return html`
          <onboard-complete
            .message=${params.message as string}
            @close=${() => this.handleResponse(true)}
          ></onboard-complete>
        `;
      
      default:
        return html`<p>Unknown prompt type: ${type}</p>`;
    }
  }

  private renderComplete(): TemplateResult {
    const isSuccess = this.completeMessage?.type === "complete";
    const isCancelled = this.completeMessage?.type === "cancelled";

    let message = "";
    if (isSuccess) {
      message = t("complete.description");
    } else if (isCancelled) {
      // Translate known cancellation reasons
      const reason = (this.completeMessage as { reason?: string })?.reason || "";
      if (reason.includes("risk not accepted")) {
        message = t("cancelled.risk_not_accepted");
      } else {
        message = t("cancelled.default");
      }
    } else {
      message = this.completeMessage?.message || t("error.unknown");
    }

    return html`
      <div class="complete-message">
        <div class="complete-icon">${isSuccess ? "✅" : isCancelled ? "ℹ️" : "❌"}</div>
        <h2 class="complete-title">
          ${isSuccess ? t("complete.title") : isCancelled ? t("cancelled.title") : t("error.title")}
        </h2>
        <p class="complete-text">${message}</p>
        ${!isSuccess ? html`
          <button class="retry-button" @click=${() => window.location.reload()}>
            ${t("error.retry")}
          </button>
        ` : ""}
      </div>
    `;
  }

  private renderError(): TemplateResult {
    return html`
      <div class="error-container">
        <div class="error-icon">⚠️</div>
        <p class="error-message">${t("app.connection_error")}</p>
        <button class="retry-button" @click=${this.handleRetry}>
          ${t("error.retry")}
        </button>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "onboard-app": OnboardApp;
  }
}
