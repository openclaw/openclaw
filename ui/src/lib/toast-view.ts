import { html, nothing } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { icons } from "../components/icons.ts";
import { t } from "../i18n/index.ts";
import { formatUiExternalText } from "./format-error.ts";
import type { ToastOptions } from "./toast.ts";

export function renderToast(
  toast: ToastOptions,
  active: boolean,
  anchorRect: DOMRect | null,
  events: {
    action: () => void;
    dismiss: () => void;
    hover: (hovered: boolean) => void;
    focus: (focused: boolean) => void;
    focusOut: (event: FocusEvent) => void;
    transitionEnd: (event: TransitionEvent) => void;
  },
) {
  const action =
    toast.actionLabel && toast.onAction
      ? html`<button type="button" class="app-toast__action" @click=${events.action}>
          ${toast.actionLabel}
        </button>`
      : nothing;
  return html`
    <div
      class="app-toast ${toast.title ? "app-toast--notification" : ""} ${anchorRect ? "app-toast--anchored" : toast.placement === "bottom" ? "app-toast--bottom" : ""}"
      data-active=${active ? "true" : "false"}
      style=${styleMap(
        anchorRect
          ? {
              "--app-toast-anchor-center": `${anchorRect.left + anchorRect.width / 2}px`,
              "--app-toast-anchor-top": `${anchorRect.top + (toast.anchorTopOffset ?? 0)}px`,
              "--app-toast-anchor-width": `${anchorRect.width}px`,
            }
          : {},
      )}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      @pointerenter=${() => events.hover(true)}
      @pointerleave=${() => events.hover(false)}
      @focusin=${() => events.focus(true)}
      @focusout=${events.focusOut}
      @transitionend=${events.transitionEnd}
    >
      ${toast.title ? html`<strong class="app-toast__title" title=${typeof toast.title === "string" ? toast.title : nothing}>${toast.title}</strong>` : nothing}
      ${
        toast.icon
          ? html`<span class="app-toast__icon" aria-hidden="true">${toast.icon}</span>`
          : nothing
      }
      <span class="app-toast__message"
        >${
          typeof toast.message === "string" ? formatUiExternalText(toast.message) : toast.message
        }</span
      >
      ${
        toast.title && action !== nothing
          ? html`<div class="app-toast__footer">${action}</div>`
          : action
      }
      <button
        type="button"
        class="app-toast__dismiss"
        aria-label=${t("common.dismiss")}
        @click=${events.dismiss}
      >
        ${icons.x}
      </button>
    </div>
  `;
}
