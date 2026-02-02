/**
 * Gateway Auth Modal Component
 * A modal dialog for Gateway authentication (token or password).
 */

import { html, nothing, type TemplateResult } from "lit";
import { icon } from "../icons";

export type AuthMethod = "token" | "password";

export type AuthModalOptions = {
  open: boolean;
  method: AuthMethod;
  value: string;
  error: string | null;
  gatewayUrl?: string;
  onMethodChange: (method: AuthMethod) => void;
  onValueChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
};

/**
 * Renders the auth modal template for embedding in the app render tree.
 */
export function renderAuthModal(opts: AuthModalOptions): TemplateResult | typeof nothing {
  if (!opts.open) return nothing;

  const { method, value, error, gatewayUrl, onMethodChange, onValueChange, onSubmit, onCancel } =
    opts;

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      onCancel();
    } else if (e.key === "Enter" && value.trim()) {
      e.preventDefault();
      onSubmit();
    }
  };

  const handleBackdropClick = (e: Event) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  };

  const handleTabClick = (newMethod: AuthMethod) => (e: Event) => {
    e.preventDefault();
    onMethodChange(newMethod);
  };

  const handleInput = (e: Event) => {
    const target = e.target as HTMLInputElement;
    onValueChange(target.value);
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    onSubmit();
  };

  return html`
    <div
      class="modal-backdrop"
      @click=${handleBackdropClick}
      @keydown=${handleKeydown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-modal-title"
    >
      <div class="modal" style="max-width: 420px;">
        <div class="modal-header">
          <h2 id="auth-modal-title" class="modal-title">
            <span class="modal-title__icon" style="display: inline-flex; align-items: center; margin-right: 8px; width: 20px; height: 20px;">${icon("plug")}</span>
            Gateway Authentication
          </h2>
          <button
            class="btn btn--sm btn--icon"
            @click=${onCancel}
            aria-label="Close"
            title="Close"
          >
            <span style="display: inline-flex; width: 16px; height: 16px;">${icon("x")}</span>
          </button>
        </div>

        <div class="modal-body">
          ${gatewayUrl
            ? html`
                <p style="margin: 0 0 16px; color: var(--muted); font-size: 13px;">
                  Authenticating to: <code style="background: var(--bg-secondary); padding: 2px 6px; border-radius: 4px;">${gatewayUrl}</code>
                </p>
              `
            : nothing}

          <div class="auth-tabs" style="display: flex; gap: 4px; margin-bottom: 16px;">
            <button
              class="btn ${method === "token" ? "btn--primary" : "btn--secondary"}"
              style="flex: 1;"
              @click=${handleTabClick("token")}
            >
              Token
            </button>
            <button
              class="btn ${method === "password" ? "btn--primary" : "btn--secondary"}"
              style="flex: 1;"
              @click=${handleTabClick("password")}
            >
              Password
            </button>
          </div>

          <form @submit=${handleSubmit}>
            <div style="margin-bottom: 16px;">
              <label
                for="auth-input"
                style="display: block; margin-bottom: 6px; color: var(--muted); font-size: 13px;"
              >
                ${method === "token" ? "Gateway Token" : "Gateway Password"}
              </label>
              <input
                id="auth-input"
                type="${method === "password" ? "password" : "text"}"
                class="input"
                style="width: 100%;"
                placeholder="${method === "token"
                  ? "Enter your gateway token..."
                  : "Enter your gateway password..."}"
                .value=${value}
                @input=${handleInput}
                autocomplete="${method === "password" ? "current-password" : "off"}"
                autofocus
              />
            </div>

            ${error
              ? html`
                  <div
                    style="
                      display: flex;
                      align-items: center;
                      padding: 10px 12px;
                      margin-bottom: 16px;
                      background: var(--danger-bg, rgba(239, 68, 68, 0.1));
                      border: 1px solid var(--danger, #ef4444);
                      border-radius: 6px;
                      color: var(--danger, #ef4444);
                      font-size: 13px;
                    "
                  >
                    <span style="flex-shrink: 0;">⚠</span>
                    <span style="margin-left: 6px;">${error}</span>
                  </div>
                `
              : nothing}

            <p style="margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5;">
              ${method === "token"
                ? html`Enter the gateway token from your configuration. This is stored locally and used for all future connections.`
                : html`Enter your gateway password. Passwords are not stored and must be re-entered each session.`}
            </p>
          </form>
        </div>

        <div class="modal-footer">
          <button class="btn btn--secondary" @click=${onCancel}>Cancel</button>
          <button
            class="btn btn--primary"
            @click=${onSubmit}
            ?disabled=${!value.trim()}
          >
            Authenticate
          </button>
        </div>
      </div>
    </div>
  `;
}
