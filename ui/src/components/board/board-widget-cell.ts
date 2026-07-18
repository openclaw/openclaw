import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../i18n/index.ts";
import type { BoardGridDirection, BoardGridRect } from "../../lib/board/grid.ts";
import { toCssPlacement } from "../../lib/board/grid.ts";
import type {
  BoardGrantDecision,
  BoardTab,
  BoardWidget,
  BoardWidgetFrameUrl,
} from "../../lib/board/view-types.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

export const BOARD_SIZE_PRESETS = {
  sm: { w: 3, h: 3 },
  md: { w: 6, h: 4 },
  lg: { w: 8, h: 6 },
  xl: { w: 12, h: 8 },
} as const;

export type BoardWidgetCellCallbacks = {
  grant: (name: string, decision: BoardGrantDecision) => Promise<void>;
  movePointerDown: (widget: BoardWidget, event: PointerEvent) => void;
  resizePointerDown: (widget: BoardWidget, event: PointerEvent) => void;
  moveToTab: (widget: BoardWidget, tabId: string) => Promise<void>;
  resizeTo: (widget: BoardWidget, w: number, h: number) => Promise<void>;
  remove: (widget: BoardWidget) => Promise<void>;
  nudge: (widget: BoardWidget, direction: BoardGridDirection) => Promise<void>;
  focus: (widget: BoardWidget, direction: BoardGridDirection) => void;
  focusChanged: (name: string) => void;
};

export class OpenClawBoardWidgetCell extends OpenClawLightDomElement {
  @property({ attribute: false }) widget?: BoardWidget;
  @property({ attribute: false }) rect?: BoardGridRect;
  @property({ attribute: false }) tabs: readonly BoardTab[] = [];
  @property({ attribute: false }) widgetFrameUrl?: BoardWidgetFrameUrl;
  @property({ attribute: false }) callbacks?: BoardWidgetCellCallbacks;
  @property({ type: Boolean }) dragging = false;
  @property({ type: Number }) focusTabIndex = -1;
  @property({ type: Number }) positionInSet = 1;
  @property({ type: Number }) setSize = 1;
  @property({ type: Boolean }) busy = false;

  @state() private actionError = "";
  @state() private actionPending = false;

  override willUpdate(changed: PropertyValues<this>): void {
    const previousWidget = changed.get("widget");
    if (previousWidget && previousWidget !== this.widget) {
      this.actionError = "";
    }
  }

  private closeMenu(): void {
    this.querySelector<HTMLDetailsElement>(".board-widget__menu")?.removeAttribute("open");
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    if (this.actionPending || this.busy) {
      return;
    }
    this.actionPending = true;
    this.actionError = "";
    this.closeMenu();
    try {
      await action();
    } catch (error) {
      this.actionError = error instanceof Error ? error.message : String(error);
    } finally {
      this.actionPending = false;
    }
  }

  private renderMenu(widget: BoardWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    const otherTabs = this.tabs.filter((tab) => tab.tabId !== widget.tabId);
    return html`
      <details class="board-widget__menu">
        <summary aria-label=${t("board.widget.menuLabel")} title=${t("board.widget.menuLabel")}>
          ⋮
        </summary>
        <div class="board-widget__menu-popover" role="menu">
          <div class="board-widget__menu-heading">${t("board.widget.moveToTab")}</div>
          ${otherTabs.length > 0
            ? otherTabs.map(
                (tab) => html`
                  <button
                    type="button"
                    role="menuitem"
                    ?disabled=${this.busy || this.actionPending}
                    @click=${() =>
                      void this.runAction(() => callbacks.moveToTab(widget, tab.tabId))}
                  >
                    ${tab.title}
                  </button>
                `,
              )
            : html`<span class="board-widget__menu-empty">${t("board.widget.noOtherTabs")}</span>`}
          <div class="board-widget__menu-heading">${t("board.widget.resize")}</div>
          <div class="board-widget__preset-row" role="group" aria-label=${t("board.widget.resize")}>
            ${Object.entries(BOARD_SIZE_PRESETS).map(
              ([label, size]) => html`
                <button
                  type="button"
                  title=${`${size.w}×${size.h}`}
                  ?disabled=${this.busy || this.actionPending}
                  @click=${() =>
                    void this.runAction(() => callbacks.resizeTo(widget, size.w, size.h))}
                >
                  ${label.toUpperCase()}
                </button>
              `,
            )}
          </div>
          <div class="board-widget__menu-separator"></div>
          <button
            class="board-widget__menu-danger"
            type="button"
            role="menuitem"
            ?disabled=${this.busy || this.actionPending}
            @click=${() => void this.runAction(() => callbacks.remove(widget))}
          >
            ${t("board.widget.remove")}
          </button>
        </div>
      </details>
    `;
  }

  private renderPending(widget: BoardWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    return html`
      <div class="board-widget__grant board-widget__grant--pending" data-test-id="board-pending">
        <div class="board-widget__grant-mark" aria-hidden="true">!</div>
        <strong>${t("board.widget.needsApproval")}</strong>
        <span>${t("board.widget.needsApprovalDetail")}</span>
        <div class="board-widget__grant-actions">
          <button
            class="btn btn--small btn--primary"
            type="button"
            data-test-id="board-grant-allow"
            ?disabled=${this.busy || this.actionPending}
            @click=${() => void this.runAction(() => callbacks.grant(widget.name, "granted"))}
          >
            ${t("board.widget.allow")}
          </button>
          <button
            class="btn btn--small"
            type="button"
            data-test-id="board-grant-reject"
            ?disabled=${this.busy || this.actionPending}
            @click=${() => void this.runAction(() => callbacks.grant(widget.name, "rejected"))}
          >
            ${t("board.widget.reject")}
          </button>
        </div>
        ${this.actionError ? this.renderActionError(this.actionError, true) : nothing}
      </div>
    `;
  }

  private renderRejected(widget: BoardWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    return html`
      <div class="board-widget__grant board-widget__grant--rejected" data-test-id="board-rejected">
        <strong>${t("board.widget.rejected")}</strong>
        <span>${t("board.widget.rejectedDetail")}</span>
        <button
          class="btn btn--small"
          type="button"
          ?disabled=${this.busy || this.actionPending}
          @click=${() => void this.runAction(() => callbacks.remove(widget))}
        >
          ${t("board.widget.remove")}
        </button>
      </div>
    `;
  }

  private renderFrame(widget: BoardWidget): TemplateResult {
    if (!this.widgetFrameUrl) {
      throw new Error(t("board.widget.frameResolverMissing"));
    }
    const src = this.widgetFrameUrl(widget.name, widget.revision);
    return html`
      <iframe
        class="board-widget__frame"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        loading="lazy"
        title=${widget.title || widget.name}
        src=${src}
      ></iframe>
    `;
  }

  private renderBody(widget: BoardWidget, callbacks: BoardWidgetCellCallbacks): TemplateResult {
    if (widget.grantState === "pending") {
      return this.renderPending(widget, callbacks);
    }
    if (widget.grantState === "rejected") {
      return this.renderRejected(widget, callbacks);
    }
    return this.renderFrame(widget);
  }

  private renderError(error: unknown): TemplateResult {
    const message = error instanceof Error ? error.message : String(error);
    return html`
      <div class="board-widget__error" role="alert" data-test-id="board-widget-error">
        <strong>${t("board.widget.errorTitle")}</strong>
        <span>${t("board.widget.errorDetail")}</span>
        <details>
          <summary>${t("board.widget.errorShow")}</summary>
          <code>${message}</code>
        </details>
      </div>
    `;
  }

  private renderActionError(error: string, inline = false): TemplateResult {
    return html`
      <div
        class=${`board-widget__error ${inline ? "board-widget__error--inline" : ""}`}
        role="alert"
        data-test-id="board-widget-action-error"
      >
        <strong>${t("board.widget.actionErrorTitle")}</strong>
        <span>${t("board.widget.actionErrorDetail")}</span>
        <details>
          <summary>${t("board.widget.errorShow")}</summary>
          <code>${error}</code>
        </details>
      </div>
    `;
  }

  private handleKeyDown(
    event: KeyboardEvent,
    widget: BoardWidget,
    callbacks: BoardWidgetCellCallbacks,
  ): void {
    if (event.target !== event.currentTarget) {
      return;
    }
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
    if (event.altKey) {
      void this.runAction(() => callbacks.nudge(widget, direction));
    } else {
      callbacks.focus(widget, direction);
    }
  }

  override render() {
    const widget = this.widget;
    const rect = this.rect;
    const callbacks = this.callbacks;
    if (!widget || !rect || !callbacks) {
      return nothing;
    }
    let body: TemplateResult;
    let bodyErrored = false;
    try {
      body = this.renderBody(widget, callbacks);
    } catch (error) {
      body = this.renderError(error);
      bodyErrored = true;
    }
    const label = widget.title || widget.name;
    const bodyScrollable =
      bodyErrored ||
      this.actionError !== "" ||
      widget.grantState === "pending" ||
      widget.grantState === "rejected";
    return html`
      <section
        class=${`board-widget ${this.dragging ? "board-widget--dragging" : ""}`}
        style=${toCssPlacement(rect)}
        role="listitem"
        tabindex=${this.focusTabIndex}
        aria-posinset=${this.positionInSet}
        aria-setsize=${this.setSize}
        aria-label=${t("board.widget.cellLabel", { title: label })}
        data-widget-name=${widget.name}
        data-test-id="board-widget"
        @focus=${() => callbacks.focusChanged(widget.name)}
        @keydown=${(event: KeyboardEvent) => this.handleKeyDown(event, widget, callbacks)}
      >
        <header class="board-widget__bar">
          <span
            class="board-widget__drag-handle"
            aria-hidden="true"
            title=${t("board.widget.moveHandle", { title: label })}
            @pointerdown=${(event: PointerEvent) => callbacks.movePointerDown(widget, event)}
          >
            <span aria-hidden="true">⠿</span>
          </span>
          <span class="board-widget__title" title=${label}>${label}</span>
          <span class="board-widget__kind"
            >${widget.contentKind === "mcp-app"
              ? t("board.widget.kindMcp")
              : t("board.widget.kindHtml")}</span
          >
          ${this.renderMenu(widget, callbacks)}
        </header>
        <div
          class=${`board-widget__body ${bodyScrollable ? "board-widget__body--scrollable" : ""}`}
        >
          ${body}
          ${this.actionError && widget.grantState !== "pending"
            ? html`<div class="board-widget__error-overlay">
                ${this.renderActionError(this.actionError)}
              </div>`
            : nothing}
        </div>
        <span
          class="board-widget__resize-handle"
          aria-hidden="true"
          title=${t("board.widget.resizeHandle", { title: label })}
          @pointerdown=${(event: PointerEvent) => callbacks.resizePointerDown(widget, event)}
        ></span>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-board-widget-cell")) {
  customElements.define("openclaw-board-widget-cell", OpenClawBoardWidgetCell);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-widget-cell": OpenClawBoardWidgetCell;
  }
}
