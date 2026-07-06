// Cell chrome for a dashboard widget: title bar, collapse toggle, kebab menu,
// provenance badge, and a per-cell error boundary. Pure render fns (workboard
// view idiom) — the Workspaces view owns state and passes callbacks in.
//
// The error boundary wraps the widget body render: a throw yields an error card in
// this cell only, so the shell and sibling widgets are unaffected (spec-30).

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { gridPlacementStyle } from "../lib/dashboard/grid.ts";
import { dashboardAgentProvenance, type DashboardBindingResult } from "../lib/dashboard/index.ts";
import type {
  DashboardWidget,
  DashboardWidgetStatus,
  WidgetManifestView,
} from "../lib/dashboard/types.ts";
import { getBuiltinRenderer, type BuiltinWidgetContext } from "../lib/dashboard/widgets/index.ts";
import { renderCustomWidgetHost, type CustomWidgetHostContext } from "./dashboard-custom-widget.ts";
import { icons } from "./icons.ts";

export type DashboardWidgetCellCallbacks = {
  onToggleCollapse: (widget: DashboardWidget) => void;
  onToggleMenu: (widget: DashboardWidget) => void;
  onHide: (widget: DashboardWidget) => void;
  onRemove: (widget: DashboardWidget) => void;
  onEditTitle: (widget: DashboardWidget) => void;
  onMoveToTab: (widget: DashboardWidget) => void;
  onMovePointerDown: (widget: DashboardWidget, event: PointerEvent) => void;
  onResizePointerDown: (widget: DashboardWidget, event: PointerEvent) => void;
  onKeyboardNudge: (
    widget: DashboardWidget,
    mode: "move" | "resize",
    direction: "left" | "right" | "up" | "down",
  ) => void;
};

/**
 * Custom-widget (`custom:<name>`) rendering context (L5). Passed only for custom
 * widgets; builtin widgets ignore it. Carries the registry approval status (gates
 * whether an iframe is ever built), the loaded manifest, the sandbox host context,
 * and the operator-only approve/reject actions for the pending placeholder.
 */
export type DashboardCustomWidgetContext = {
  status: DashboardWidgetStatus | null;
  manifest: WidgetManifestView | null;
  host: CustomWidgetHostContext;
  onApprove: (widget: DashboardWidget) => void;
  onReject: (widget: DashboardWidget) => void;
};

export type DashboardWidgetCellProps = {
  widget: DashboardWidget;
  /** Resolved binding value for the primary binding, or an error to surface. */
  binding: DashboardBindingResult | null;
  menuOpen: boolean;
  pending: boolean;
  /** When set, this cell is the live drag/resize ghost source. */
  dragging: boolean;
  /** Ambient context builtins may need (embed policy for iframe-embed). */
  builtinContext: BuiltinWidgetContext;
  callbacks: DashboardWidgetCellCallbacks;
  /** Present for `custom:` widgets only (L5); builtin widgets leave this undefined. */
  custom?: DashboardCustomWidgetContext;
};

/**
 * Visible widget title with a trailing " (custom)" provenance suffix stripped
 * (#8). The suffix is redundant with the AI/provenance chip and only causes
 * truncation; the full title is still exposed via the `title=` attribute.
 */
export function displayWidgetTitle(title: string): string {
  return title.replace(/\s*\(custom\)\s*$/iu, "").trim() || title;
}

/** Renders the provenance chip when a widget was authored by an agent. */
function renderProvenanceChip(widget: DashboardWidget): TemplateResult | typeof nothing {
  const agentId = dashboardAgentProvenance(widget.createdBy);
  if (!agentId) {
    return nothing;
  }
  return html`<span
    class="dashboard-widget__provenance"
    title=${t("dashboard.widget.provenanceTooltip", { agent: agentId })}
    >${t("dashboard.widget.provenanceChip")}</span
  >`;
}

function renderMenu(
  widget: DashboardWidget,
  callbacks: DashboardWidgetCellCallbacks,
): TemplateResult {
  return html`
    <div class="dashboard-widget__menu" role="menu">
      <button
        class="dashboard-widget__menu-item"
        type="button"
        role="menuitem"
        @click=${() => callbacks.onEditTitle(widget)}
      >
        ${t("dashboard.widget.menu.editTitle")}
      </button>
      <button
        class="dashboard-widget__menu-item"
        type="button"
        role="menuitem"
        @click=${() => callbacks.onMoveToTab(widget)}
      >
        ${t("dashboard.widget.menu.moveToTab")}
      </button>
      <button
        class="dashboard-widget__menu-item"
        type="button"
        role="menuitem"
        @click=${() => callbacks.onHide(widget)}
      >
        ${t("dashboard.widget.menu.hide")}
      </button>
      <button
        class="dashboard-widget__menu-item dashboard-widget__menu-item--danger"
        type="button"
        role="menuitem"
        @click=${() => callbacks.onRemove(widget)}
      >
        ${t("dashboard.widget.menu.remove")}
      </button>
    </div>
  `;
}

/**
 * Renders a builtin widget body via the L4 registry. A binding error is
 * re-thrown so the cell error boundary shows it inline; unknown/custom kinds
 * render a placeholder (L5 replaces custom with the sandboxed iframe host).
 */
export function renderBuiltinWidget(
  widget: DashboardWidget,
  binding: DashboardBindingResult | null,
  ctx: BuiltinWidgetContext,
): TemplateResult {
  if (binding && "error" in binding) {
    // A binding failure is data-level, not a render throw: show it inline so the
    // widget stays mounted and refetches on the next broadcast.
    throw new Error(binding.error);
  }
  const value = binding && "value" in binding ? binding.value : undefined;
  const renderer = getBuiltinRenderer(widget.kind);
  if (renderer) {
    return renderer(widget, value, ctx);
  }
  if (widget.kind.startsWith("custom:")) {
    // Custom widgets are dispatched by renderWidgetBody BEFORE this builtin path;
    // reaching here means no L5 host context was supplied (e.g. a unit test
    // rendering the builtin body in isolation). Neutral placeholder — never an
    // iframe without a manifest.
    return html`<div class="dashboard-widget__placeholder">
      ${t("dashboard.widget.customPlaceholder")}
    </div>`;
  }
  return html`<div class="dashboard-widget__placeholder">
    ${t("dashboard.widget.unknownKind", { kind: widget.kind })}
  </div>`;
}

/**
 * Renders a `custom:<name>` widget (L5). The registry status is the render gate,
 * mirroring the server's approved-only serving gate:
 * - `approved` → the sandboxed iframe host (only path that ever builds an iframe).
 * - `pending`  → a placeholder card with operator-only Approve/Reject.
 * - `rejected` / unknown → a neutral placeholder; NO iframe is constructed.
 */
export function renderCustomWidget(
  widget: DashboardWidget,
  custom: DashboardCustomWidgetContext,
): TemplateResult {
  if (custom.status === "approved") {
    if (!custom.manifest) {
      // Approved but the manifest has not loaded yet: hold the cell without an
      // iframe until the manifest resolves (the parent re-renders on load).
      return html`<div
        class="dashboard-widget__placeholder"
        data-test-id="dashboard-custom-loading"
      >
        ${t("dashboard.widget.customLoading")}
      </div>`;
    }
    return renderCustomWidgetHost({
      widget,
      manifest: custom.manifest,
      context: custom.host,
    });
  }
  if (custom.status === "pending") {
    const author = dashboardAgentProvenance(widget.createdBy);
    return html`
      <div
        class="dashboard-widget__approval"
        role="group"
        data-test-id="dashboard-custom-pending"
        aria-label=${t("dashboard.widget.approval.title")}
      >
        <div class="dashboard-widget__approval-title">${t("dashboard.widget.approval.title")}</div>
        <div class="dashboard-widget__approval-sub">
          ${author
            ? t("dashboard.widget.approval.byAgent", { agent: author })
            : t("dashboard.widget.approval.byUnknown")}
        </div>
        <div class="dashboard-widget__approval-actions">
          <button
            class="btn btn--small btn--primary"
            type="button"
            data-test-id="dashboard-custom-approve"
            @click=${() => custom.onApprove(widget)}
          >
            ${t("dashboard.widget.approval.approve")}
          </button>
          <button
            class="btn btn--small"
            type="button"
            data-test-id="dashboard-custom-reject"
            @click=${() => custom.onReject(widget)}
          >
            ${t("dashboard.widget.approval.reject")}
          </button>
        </div>
      </div>
    `;
  }
  return html`<div class="dashboard-widget__placeholder" data-test-id="dashboard-custom-rejected">
    ${t("dashboard.widget.approval.unavailable")}
  </div>`;
}

/**
 * Error boundary around the widget body. Any throw during the builtin render (a
 * broken widget, a bad binding) is caught and rendered as an error card in THIS
 * cell — siblings and the shell keep rendering (spec-30 acceptance criterion).
 */
export function renderWidgetBody(
  widget: DashboardWidget,
  binding: DashboardBindingResult | null,
  ctx: BuiltinWidgetContext,
  callbacks: DashboardWidgetCellCallbacks,
  custom?: DashboardCustomWidgetContext,
): TemplateResult {
  try {
    // Custom widgets (L5) dispatch here, inside the same error boundary so a throw
    // while building the host still isolates to this cell.
    if (widget.kind.startsWith("custom:") && custom) {
      return renderCustomWidget(widget, custom);
    }
    return renderBuiltinWidget(widget, binding, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return html`
      <div class="dashboard-widget__error" role="alert" data-test-id="dashboard-widget-error">
        <div class="dashboard-widget__error-title">${t("dashboard.widget.errorTitle")}</div>
        <div class="dashboard-widget__error-humane">${t("dashboard.widget.errorHumane")}</div>
        <details class="dashboard-widget__error-detail">
          <summary>${t("dashboard.widget.errorDetailSummary")}</summary>
          <div class="dashboard-widget__error-message">${message}</div>
        </details>
        <button class="btn btn--small" type="button" @click=${() => callbacks.onRemove(widget)}>
          ${t("dashboard.widget.menu.remove")}
        </button>
      </div>
    `;
  }
}

export function renderWidgetCell(props: DashboardWidgetCellProps): TemplateResult {
  const { widget, callbacks } = props;
  const classes = [
    "dashboard-widget",
    widget.collapsed ? "dashboard-widget--collapsed" : "",
    props.pending ? "dashboard-widget--pending" : "",
    props.dragging ? "dashboard-widget--dragging" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return html`
    <section
      class=${classes}
      style=${gridPlacementStyle(widget.grid)}
      data-widget-id=${widget.id}
      data-test-id="dashboard-widget"
    >
      <header
        class="dashboard-widget__bar"
        @pointerdown=${(event: PointerEvent) => callbacks.onMovePointerDown(widget, event)}
      >
        <button
          class="dashboard-widget__collapse"
          type="button"
          aria-expanded=${widget.collapsed ? "false" : "true"}
          aria-label=${widget.collapsed
            ? t("dashboard.widget.expand")
            : t("dashboard.widget.collapse")}
          @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
          @click=${() => callbacks.onToggleCollapse(widget)}
        >
          ${widget.collapsed ? icons.chevronRight : icons.chevronDown}
        </button>
        <span class="dashboard-widget__title" title=${widget.title}
          >${displayWidgetTitle(widget.title)}</span
        >
        ${renderProvenanceChip(widget)}
        <span
          class="dashboard-widget__handle"
          role="button"
          tabindex="0"
          aria-label=${t("dashboard.widget.moveHandle")}
          @keydown=${(event: KeyboardEvent) => handleNudgeKey(event, widget, "move", callbacks)}
          >${icons.arrowUpDown}</span
        >
        <button
          class="dashboard-widget__menu-toggle"
          type="button"
          aria-haspopup="menu"
          aria-expanded=${props.menuOpen ? "true" : "false"}
          aria-label=${t("dashboard.widget.menuLabel")}
          @pointerdown=${(event: PointerEvent) => event.stopPropagation()}
          @click=${() => callbacks.onToggleMenu(widget)}
        >
          ${icons.moreHorizontal}
        </button>
        ${props.menuOpen ? renderMenu(widget, callbacks) : nothing}
      </header>
      ${widget.collapsed
        ? nothing
        : html`
            <div class="dashboard-widget__body">
              ${renderWidgetBody(
                widget,
                props.binding,
                props.builtinContext,
                callbacks,
                props.custom,
              )}
            </div>
            <span
              class="dashboard-widget__resize"
              role="button"
              tabindex="0"
              aria-label=${t("dashboard.widget.resizeHandle")}
              @pointerdown=${(event: PointerEvent) => callbacks.onResizePointerDown(widget, event)}
              @keydown=${(event: KeyboardEvent) =>
                handleNudgeKey(event, widget, "resize", callbacks)}
            ></span>
          `}
    </section>
  `;
}

/** Keyboard fallback for move/resize (a11y): arrow keys nudge by one grid unit. */
function handleNudgeKey(
  event: KeyboardEvent,
  widget: DashboardWidget,
  mode: "move" | "resize",
  callbacks: DashboardWidgetCellCallbacks,
): void {
  const direction =
    event.key === "ArrowLeft"
      ? "left"
      : event.key === "ArrowRight"
        ? "right"
        : event.key === "ArrowUp"
          ? "up"
          : event.key === "ArrowDown"
            ? "down"
            : null;
  if (!direction) {
    return;
  }
  event.preventDefault();
  callbacks.onKeyboardNudge(widget, mode, direction);
}
