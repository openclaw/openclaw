import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { solidContent } from "../lit/solid-content.tsx";
import { icon } from "./icons.ts";
import { renderLoadingState } from "./loading-state.ts";
import {
  AgentStartupState,
  LazyViewError,
  LegacyPanelErrorState,
} from "./solid/lazy-view-error.tsx";

export function renderAgentStartupState() {
  return html`${solidContent(AgentStartupState, {})}`;
}

type LazyElementState =
  | { status: "loading"; element: { label: string } }
  | { status: "error"; element: { label: string }; error: unknown; stale: boolean };

export function renderLazyElementState(
  state: LazyElementState,
  onRetry: () => void,
  onClose: () => void,
) {
  return state.status === "loading"
    ? renderLoadingState()
    : renderLazyViewError({
        actionLabel: t("common.retry"),
        error: state.error,
        stale: state.stale,
        subtitle: state.element.label,
        onRetry,
        onClose,
      });
}

export function renderLazyElementModal(controller: {
  visibleState: LazyElementState | undefined;
  retry(): void;
  close(): void;
}) {
  const state = controller.visibleState;
  if (!state) {
    return nothing;
  }
  const close = () => controller.close();
  const loading = state.status === "loading";
  return html`<openclaw-modal-dialog
    class=${loading ? "lazy-element-loading-modal" : nothing}
    label=${state.element.label}
    @modal-cancel=${close}
  >
    ${
      loading
        ? html`<section class="lazy-element-loading">
            <header class="lazy-element-loading__header">
              <h2>${state.element.label}</h2>
              <button
                class="btn btn--ghost btn--icon"
                type="button"
                aria-label=${t("common.close")}
                @click=${close}
              >
                ${icon("x")}
              </button>
            </header>
            <div
              class="lazy-element-loading__status"
              role="status"
              aria-live="polite"
              aria-label=${t("common.loading")}
            >
              <span class="btn__spinner" aria-hidden="true"></span>
              <span>${t("common.loading")}</span>
            </div>
          </section>`
        : renderLazyElementState(state, () => controller.retry(), close)
    }
  </openclaw-modal-dialog>`;
}

export function renderLazyViewError(params: {
  actionLabel?: string;
  error: unknown;
  onClose?: (event: Event) => void;
  onRetry: (event: Event) => void;
  render?: () => unknown;
  inline?: boolean;
  stale?: boolean;
  subtitle?: string;
}) {
  const { render, inline, ...props } = params;
  return html`
    ${render?.() ?? nothing}
    ${solidContent(LazyViewError, {
      ...props,
      inline: inline ?? Boolean(render),
    })}
  `;
}

export function renderPanelErrorState(params: {
  actions?: TemplateResult;
  className?: string;
  detail?: string;
  inline?: boolean;
  role?: "alert" | "status";
  stale?: boolean;
  subtitle: string;
  title: string;
}) {
  return html`${solidContent(LegacyPanelErrorState, params)}`;
}
