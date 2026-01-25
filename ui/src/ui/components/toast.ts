/**
 * Toast Notification System
 * A Lit component for displaying toast notifications with support for
 * success, error, warning, and info types.
 */

import { LitElement, html, css, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

export type ToastType = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  type?: ToastType;
  title?: string;
  message: string;
  duration?: number; // ms, 0 = manual dismiss only
  dismissible?: boolean;
}

interface ToastEntry extends ToastOptions {
  id: string;
  createdAt: number;
  exiting?: boolean;
}

let toastIdCounter = 0;

// Global toast manager for use outside of components
let globalToastContainer: ToastContainer | null = null;

export function toast(options: ToastOptions | string): string {
  const opts: ToastOptions = typeof options === "string" ? { message: options } : options;
  if (!globalToastContainer) {
    // Create container if it doesn't exist
    const existing = document.querySelector("toast-container");
    if (existing) {
      globalToastContainer = existing as ToastContainer;
    } else {
      globalToastContainer = document.createElement("toast-container") as ToastContainer;
      document.body.appendChild(globalToastContainer);
    }
  }
  return globalToastContainer.addToast(opts);
}

// Convenience methods
toast.success = (message: string, title?: string) =>
  toast({ type: "success", message, title });
toast.error = (message: string, title?: string) =>
  toast({ type: "error", message, title });
toast.warning = (message: string, title?: string) =>
  toast({ type: "warning", message, title });
toast.info = (message: string, title?: string) =>
  toast({ type: "info", message, title });
toast.dismiss = (id: string) => globalToastContainer?.dismissToast(id);
toast.dismissAll = () => globalToastContainer?.dismissAll();

/**
 * Toast promise helper - shows loading, then success or error based on promise result
 * @param promise The promise to track
 * @param messages Messages to show for loading, success, and error states
 * @returns The promise result (for chaining)
 */
toast.promise = async <T>(
  promise: Promise<T>,
  messages: {
    loading: string;
    success: string | ((data: T) => string);
    error: string | ((err: unknown) => string);
  }
): Promise<T> => {
  const loadingId = toast({ type: "info", message: messages.loading, duration: 0 });
  try {
    const result = await promise;
    toast.dismiss(loadingId);
    const successMsg = typeof messages.success === "function"
      ? messages.success(result)
      : messages.success;
    toast.success(successMsg);
    return result;
  } catch (err) {
    toast.dismiss(loadingId);
    const errorMsg = typeof messages.error === "function"
      ? messages.error(err)
      : messages.error;
    toast.error(errorMsg);
    throw err;
  }
};

@customElement("toast-container")
export class ToastContainer extends LitElement {
  static styles = css`
    :host {
      position: fixed;
      bottom: 1rem;
      right: 1rem;
      z-index: 300;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      pointer-events: none;
    }

    .toast {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      min-width: 300px;
      max-width: 420px;
      padding: 1rem;
      background: var(--panel-strong);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg, 0.75rem);
      box-shadow: var(--shadow-elevated-lg, 0 10px 15px -3px rgba(0, 0, 0, 0.1));
      pointer-events: auto;
      animation: slideInRight 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    .toast.exiting {
      animation: slideOutRight 0.2s ease-out forwards;
    }

    @keyframes slideInRight {
      from {
        opacity: 0;
        transform: translateX(20px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }

    @keyframes slideOutRight {
      from {
        opacity: 1;
        transform: translateX(0);
      }
      to {
        opacity: 0;
        transform: translateX(20px);
      }
    }

    .toast-icon {
      flex-shrink: 0;
      width: 20px;
      height: 20px;
    }

    .toast-success .toast-icon { color: var(--ok); }
    .toast-warning .toast-icon { color: var(--warn); }
    .toast-error .toast-icon { color: var(--danger); }
    .toast-info .toast-icon { color: var(--info, #60a5fa); }

    .toast-content {
      flex: 1;
      min-width: 0;
    }

    .toast-title {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text);
      margin: 0;
    }

    .toast-message {
      font-size: 0.8125rem;
      color: var(--text-secondary, var(--muted));
      margin-top: 0.25rem;
      line-height: 1.4;
    }

    .toast-close {
      flex-shrink: 0;
      padding: 0.25rem;
      color: var(--muted);
      background: transparent;
      border: none;
      border-radius: var(--radius-sm, 0.375rem);
      cursor: pointer;
      transition: all 0.15s ease-out;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .toast-close:hover {
      color: var(--text);
      background: var(--bg-overlay);
    }

    .toast-close svg {
      width: 16px;
      height: 16px;
    }

    /* Progress bar for auto-dismiss */
    .toast-progress {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: var(--surface-2, rgba(255, 255, 255, 0.1));
      border-radius: 0 0 var(--radius-lg, 0.75rem) var(--radius-lg, 0.75rem);
      overflow: hidden;
    }

    .toast-progress-bar {
      height: 100%;
      background: var(--accent);
      animation: progress linear forwards;
    }

    @keyframes progress {
      from { width: 100%; }
      to { width: 0%; }
    }

    .toast-success .toast-progress-bar { background: var(--ok); }
    .toast-warning .toast-progress-bar { background: var(--warn); }
    .toast-error .toast-progress-bar { background: var(--danger); }
    .toast-info .toast-progress-bar { background: var(--info, #60a5fa); }

    /* Stacking animation */
    .toast:nth-last-child(2) { opacity: 0.9; transform: scale(0.98); }
    .toast:nth-last-child(3) { opacity: 0.8; transform: scale(0.96); }
    .toast:nth-last-child(n+4) { opacity: 0.7; transform: scale(0.94); }
  `;

  @state() private toasts: ToastEntry[] = [];
  private timers = new Map<string, number>();

  createRenderRoot() {
    // Use light DOM to inherit parent styles
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    globalToastContainer = this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (globalToastContainer === this) {
      globalToastContainer = null;
    }
    // Clear all timers
    this.timers.forEach((timer) => window.clearTimeout(timer));
    this.timers.clear();
  }

  addToast(options: ToastOptions): string {
    const id = `toast-${++toastIdCounter}`;
    const entry: ToastEntry = {
      id,
      type: options.type ?? "info",
      title: options.title,
      message: options.message,
      duration: options.duration ?? 5000,
      dismissible: options.dismissible ?? true,
      createdAt: Date.now(),
    };

    this.toasts = [...this.toasts, entry];

    // Auto-dismiss if duration is set
    if (entry.duration && entry.duration > 0) {
      const timer = window.setTimeout(() => {
        this.dismissToast(id);
      }, entry.duration);
      this.timers.set(id, timer);
    }

    return id;
  }

  dismissToast(id: string) {
    // Clear timer if exists
    const timer = this.timers.get(id);
    if (timer) {
      window.clearTimeout(timer);
      this.timers.delete(id);
    }

    // Mark as exiting for animation
    this.toasts = this.toasts.map((t) =>
      t.id === id ? { ...t, exiting: true } : t
    );

    // Remove after animation
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
    }, 200);
  }

  dismissAll() {
    this.toasts.forEach((t) => this.dismissToast(t.id));
  }

  private getIcon(type: ToastType) {
    switch (type) {
      case "success":
        return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
      case "error":
        return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
      case "warning":
        return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
      case "info":
      default:
        return html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`;
    }
  }

  render() {
    return html`
      <div class="toast-container">
        ${this.toasts.map((t) => html`
          <div class="toast toast-${t.type} ${t.exiting ? "exiting" : ""}" role="alert">
            <div class="toast-icon">${this.getIcon(t.type!)}</div>
            <div class="toast-content">
              ${t.title ? html`<div class="toast-title">${t.title}</div>` : nothing}
              <div class="toast-message">${t.message}</div>
            </div>
            ${t.dismissible
              ? html`
                  <button
                    class="toast-close"
                    @click=${() => this.dismissToast(t.id)}
                    aria-label="Dismiss"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                `
              : nothing}
            ${t.duration && t.duration > 0
              ? html`
                  <div class="toast-progress">
                    <div
                      class="toast-progress-bar"
                      style="animation-duration: ${t.duration}ms"
                    ></div>
                  </div>
                `
              : nothing}
          </div>
        `)}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "toast-container": ToastContainer;
  }
}
