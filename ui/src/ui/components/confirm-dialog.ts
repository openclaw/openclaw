/**
 * Confirm Dialog Component
 * A styled confirmation dialog to replace native window.confirm()
 */

import { html, render, nothing, type TemplateResult } from "lit";
import { icon } from "../icons";

export type ConfirmDialogOptions = {
  title: string;
  message: string | TemplateResult;
  confirmText?: string;
  cancelText?: string;
  variant?: "default" | "danger";
};

type DialogState = {
  open: boolean;
  options: ConfirmDialogOptions | null;
  resolve: ((confirmed: boolean) => void) | null;
};

const state: DialogState = {
  open: false,
  options: null,
  resolve: null,
};

function getOrCreateContainer(): HTMLElement {
  let container = document.getElementById("confirm-dialog-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "confirm-dialog-container";
    document.body.appendChild(container);
  }
  return container;
}

function renderDialog() {
  const container = getOrCreateContainer();

  if (!state.open || !state.options) {
    render(nothing, container);
    return;
  }

  const { title, message, confirmText = "Confirm", cancelText = "Cancel", variant = "default" } = state.options;
  const isDanger = variant === "danger";

  const handleConfirm = () => {
    state.resolve?.(true);
    closeDialog();
  };

  const handleCancel = () => {
    state.resolve?.(false);
    closeDialog();
  };

  const handleBackdropClick = (e: Event) => {
    if (e.target === e.currentTarget) {
      handleCancel();
    }
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      handleCancel();
    } else if (e.key === "Enter") {
      handleConfirm();
    }
  };

  const template = html`
    <div
      class="modal-backdrop"
      @click=${handleBackdropClick}
      @keydown=${handleKeydown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div class="modal">
        <div class="modal-header">
          <h2 id="confirm-dialog-title" class="modal-title">
            ${isDanger ? html`<span style="color: var(--danger); margin-right: 8px;">${icon("alert-triangle", { size: 20 })}</span>` : nothing}
            ${title}
          </h2>
          <button
            class="btn btn--sm btn--icon"
            @click=${handleCancel}
            aria-label="Close"
            title="Close"
          >
            ${icon("x", { size: 16 })}
          </button>
        </div>
        <div class="modal-body">
          <p style="margin: 0; color: var(--muted); line-height: 1.6;">${message}</p>
        </div>
        <div class="modal-footer">
          <button
            class="btn btn--secondary"
            @click=${handleCancel}
          >
            ${cancelText}
          </button>
          <button
            class="btn ${isDanger ? "btn--danger" : "btn--primary"}"
            @click=${handleConfirm}
            autofocus
          >
            ${confirmText}
          </button>
        </div>
      </div>
    </div>
  `;

  render(template, container);

  // Focus the confirm button after render
  requestAnimationFrame(() => {
    const confirmBtn = container.querySelector(".modal-footer .btn--primary, .modal-footer .btn--danger") as HTMLButtonElement | null;
    confirmBtn?.focus();
  });
}

function closeDialog() {
  state.open = false;
  state.options = null;
  state.resolve = null;
  renderDialog();
}

/**
 * Show a confirmation dialog and return a promise that resolves to true/false
 */
export function showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    state.open = true;
    state.options = options;
    state.resolve = resolve;
    renderDialog();
  });
}

/**
 * Convenience function for danger confirmations (destructive actions)
 */
export function showDangerConfirmDialog(
  title: string,
  message: string | TemplateResult,
  confirmText = "Delete"
): Promise<boolean> {
  return showConfirmDialog({
    title,
    message,
    confirmText,
    variant: "danger",
  });
}
