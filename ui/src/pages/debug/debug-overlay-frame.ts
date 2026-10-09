import { html, nothing, type TemplateResult } from "lit";
import type { DirectiveResult } from "lit/directive.js";
import { icons } from "../../components/icons.ts";
import {
  renderLazyViewError,
  type renderLazyElementModal,
  type renderLazyElementState,
} from "../../components/lazy-view-error.ts";
import { DEBUG_OVERLAY_REQUEST_EVENT } from "../../components/panel-toggle-contract.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/debug.css";
import { debugOverlayLayout } from "./debug-overlay-layout.ts";
import { renderDebugOverlayLoading as renderExpandedLoading } from "./debug-overlay-loading.ts";

export type DebugOverlayMode = "expanded" | "minimized";

export type DebugOverlayElement = HTMLElement & {
  open: (mode: DebugOverlayMode) => void;
  toggle: () => void;
};

export interface DebugOverlayFrameHost {
  readonly lazyCustomElements: Parameters<typeof renderLazyElementModal>[0];
  readonly pendingDebugOverlayMode: DebugOverlayMode;
  togglePendingDebugOverlayMode(): void;
}

export const debugOverlayTemplate = html`<openclaw-debug-overlay></openclaw-debug-overlay>`;

export function readDebugOverlayMode(
  event: { eventType: string; detail?: object } | null,
): DebugOverlayMode {
  return event?.eventType === DEBUG_OVERLAY_REQUEST_EVENT &&
    event.detail &&
    "mode" in event.detail &&
    event.detail.mode === "minimized"
    ? "minimized"
    : "expanded";
}

export function renderPendingDebugOverlay(
  host: DebugOverlayFrameHost,
  state: Parameters<typeof renderLazyElementState>[0],
) {
  return renderDebugOverlayFrame({
    mode: host.pendingDebugOverlayMode,
    body:
      state.status === "error"
        ? renderLazyViewError({
            actionLabel: t("common.retry"),
            error: state.error,
            stale: state.stale,
            subtitle: state.element.label,
            onRetry: () => host.lazyCustomElements.retry(),
          })
        : renderDebugOverlayLoading(host.pendingDebugOverlayMode),
    onToggleMode: () => host.togglePendingDebugOverlayMode(),
    onClose: () => host.lazyCustomElements.close(),
  });
}

export function shouldCloseDebugOverlay(
  event: KeyboardEvent,
  mode: DebugOverlayMode | "closed",
  frame: EventTarget | null,
): boolean {
  return (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    mode !== "closed" &&
    (mode !== "minimized" || (frame !== null && event.composedPath().includes(frame)))
  );
}

export function renderDebugOverlayLoading(mode: DebugOverlayMode | "closed") {
  return mode === "minimized"
    ? html`<div class="debug-overlay__compact-loading" role="status">${t("common.loading")}</div>`
    : renderExpandedLoading();
}

export function renderDebugOverlayFrame({
  mode,
  body,
  onToggleMode,
  onClose,
}: {
  mode: DebugOverlayMode;
  body: TemplateResult | DirectiveResult;
  onToggleMode: () => void;
  onClose: () => void;
}) {
  return html`
    <aside
      ${debugOverlayLayout(mode)}
      class="debug-overlay ${mode === "minimized" ? "debug-overlay--minimized" : ""}"
      aria-label=${t("debug.overlay.title")}
    >
      <header
        class="debug-overlay__header"
        role="group"
        tabindex="0"
        aria-label=${t("debug.overlay.move")}
      >
        <div>
          ${mode === "minimized" ? nothing : html`<div class="debug-overlay__eyebrow">${t("debug.overlay.eyebrow")}</div>`}
          <h2>${t("debug.overlay.title")}</h2>
        </div>
        <div class="debug-overlay__controls">
          <button
            type="button"
            class="debug-overlay__control"
            aria-label=${t(mode === "minimized" ? "debug.overlay.expand" : "debug.overlay.minimize")}
            title=${t(mode === "minimized" ? "debug.overlay.expand" : "debug.overlay.minimize")}
            @click=${onToggleMode}
          >
            ${mode === "minimized" ? icons.maximize : icons.minimize}
          </button>
          <button
            type="button"
            class="debug-overlay__control debug-overlay__close"
            aria-label=${t("common.close")}
            @click=${onClose}
          >
            ${icons.x}
          </button>
        </div>
      </header>
      <div class="debug-overlay__body">${body}</div>
    </aside>
  `;
}
