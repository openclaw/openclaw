import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { repeat } from "lit/directives/repeat.js";
import { t } from "../../i18n/index.ts";
import {
  BOARD_GRID_COLUMNS,
  BOARD_DOCUMENT_AUTO_MAX_ROWS,
  BOARD_GRID_GAP,
  BOARD_GRID_ROW_HEIGHT,
  boardChromeRowPx,
  boardWidgetGridItems,
  effectiveBoardWidgetRows,
  FINE_POINTER_QUERY,
  layout,
  nudge,
  previewDrag,
  resize,
  type BoardGridDirection,
  type BoardGridItem,
} from "../../lib/board/grid.ts";
import type { BoardOp, BoardSnapshot, BoardTab, BoardWidget } from "../../lib/board/types.ts";
import type {
  BoardGrantDecision,
  BoardViewCallbacks,
  BoardWidgetFrameUrl,
} from "../../lib/board/view-types.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import "../../styles/board.css";
import "../web-awesome-tabs.ts";
import "../web-awesome.ts";
import { orderedBoardTabs, renderBoardTabs } from "./board-tabs.ts";
import type { BoardWidgetCellCallbacks } from "./board-widget-cell.ts";
import "./board-widget-cell.ts";

type BoardPointerGesture = {
  dropValid: boolean;
  mode: "move" | "resize";
  name: string;
  originClientX: number;
  originClientY: number;
  originW: number;
  originH: number;
  pointerId: number;
  items: BoardGridItem[];
};

function orderedWidgets(snapshot: BoardSnapshot, tabId: string): BoardWidget[] {
  return snapshot.widgets
    .filter((widget) => widget.tabId === tabId)
    .toSorted(
      (left, right) => left.position - right.position || left.name.localeCompare(right.name),
    );
}

class OpenClawBoardView extends OpenClawLightDomElement {
  // Snapshots acknowledge an observer-scoped key; native views retain the query's exact owner.
  @property({ attribute: false }) session: BoardGetParams = { sessionKey: "" };
  @property({ attribute: false }) snapshot?: BoardSnapshot;
  @property({ attribute: false }) activeTabId = "";
  @property({ attribute: false }) widgetFrameUrl?: BoardWidgetFrameUrl;
  @property({ attribute: false }) callbacks?: BoardViewCallbacks;
  @property({ type: Boolean }) active = true;
  @property({ type: Boolean }) bridgeEnabled = true;
  @property({ type: Boolean }) canMutate = true;
  @property({ type: Boolean }) canGrant = true;
  @property({ type: Boolean }) fitAutoContent = false;
  @property({ attribute: false }) pageWidgetName = "";

  @state() private previewItems: BoardGridItem[] | null = null;
  @state() private gestureName = "";
  @state() private hoverTabId = "";
  @state() private announcement = "";
  @state() private announcementRevision = 0;
  @state() private actionError = "";
  @state() private focusName = "";
  @state() private mutationPending = false;

  private gesture: BoardPointerGesture | null = null;
  private mutationRequestId = 0;
  private stableCellOrder = new Map<string, number>();
  private stableCellOrderSequence = 0;
  private readonly visitedTabs = new Set<string>();
  private readonly contentHeights = new Map<string, number>();
  // Hybrid devices flip pointer capability live (mouse dock/undock); CSS moves
  // the bar between overlay and in-flow, so auto-height rows must re-layout.
  private readonly finePointerQuery =
    typeof window.matchMedia === "function" ? window.matchMedia(FINE_POINTER_QUERY) : null;
  private readonly handlePointerModeChange = () => this.requestUpdate();

  override connectedCallback(): void {
    super.connectedCallback();
    this.finePointerQuery?.addEventListener("change", this.handlePointerModeChange);
  }

  override willUpdate(changed: PropertyValues<this>): void {
    const previousSession = changed.get("session");
    const ownerChanged =
      (changed.has("session") &&
        (previousSession?.agentId !== this.session.agentId ||
          previousSession?.sessionKey !== this.session.sessionKey)) ||
      (changed.has("snapshot") &&
        changed.get("snapshot")?.sessionKey !== this.snapshot?.sessionKey);
    if (ownerChanged) {
      this.visitedTabs.clear();
      this.stableCellOrder.clear();
      this.stableCellOrderSequence = 0;
      this.contentHeights.clear();
    }
    if (changed.has("snapshot")) {
      this.actionError = "";
      const previousSnapshot = changed.get("snapshot");
      if (previousSnapshot?.sessionKey !== this.snapshot?.sessionKey) {
        this.mutationRequestId += 1;
        this.mutationPending = false;
        this.focusName = "";
      } else if (previousSnapshot && this.snapshot) {
        const previousByName = new Map(
          previousSnapshot.widgets.map((widget) => [widget.name, widget]),
        );
        for (const name of this.contentHeights.keys()) {
          const previous = previousByName.get(name);
          const current = this.snapshot.widgets.find((widget) => widget.name === name);
          if (
            !current ||
            current.contentKind !== "html" ||
            previous?.revision !== current.revision
          ) {
            this.contentHeights.delete(name);
          }
        }
      }
      const tabIds = new Set(this.snapshot?.tabs.map((tab) => tab.tabId));
      for (const tabId of this.visitedTabs) {
        if (!tabIds.has(tabId)) {
          this.visitedTabs.delete(tabId);
        }
      }
      const widgetNames = new Set(this.snapshot?.widgets.map((widget) => widget.name));
      for (const name of this.stableCellOrder.keys()) {
        if (!widgetNames.has(name)) {
          this.stableCellOrder.delete(name);
        }
      }
    }
    if (changed.has("activeTabId")) {
      this.focusName = "";
    }
    if (
      this.gesture &&
      (changed.has("snapshot") ||
        changed.has("activeTabId") ||
        changed.has("pageWidgetName") ||
        (changed.has("active") && !this.active))
    ) {
      this.cancelGesture();
    }
  }

  override disconnectedCallback(): void {
    this.finePointerQuery?.removeEventListener("change", this.handlePointerModeChange);
    this.cancelGesture();
    super.disconnectedCallback();
  }

  private activeTab(tabs: readonly BoardTab[]): BoardTab | undefined {
    return tabs.find((tab) => tab.tabId === this.activeTabId) ?? tabs[0];
  }

  private announce(message: string): void {
    this.announcement = message;
    this.announcementRevision += 1;
  }

  private async applyOps(ops: BoardOp[], announcement: string): Promise<void> {
    if (!this.callbacks) {
      return;
    }
    if (this.mutationPending) {
      throw new Error(t("board.actionInProgress"));
    }
    const sessionKey = this.snapshot?.sessionKey;
    const requestId = this.mutationRequestId + 1;
    this.mutationRequestId = requestId;
    this.mutationPending = true;
    this.actionError = "";
    try {
      await this.callbacks.applyOps(ops);
      if (requestId === this.mutationRequestId && sessionKey === this.snapshot?.sessionKey) {
        this.announce(announcement);
      }
    } catch (error) {
      if (requestId === this.mutationRequestId && sessionKey === this.snapshot?.sessionKey) {
        this.actionError = t("board.actionFailed");
        this.announce(this.actionError);
      }
      throw error;
    } finally {
      if (requestId === this.mutationRequestId) {
        this.mutationPending = false;
      }
    }
  }

  private nextPosition(tabId: string): number {
    const positions = this.snapshot?.widgets
      .filter((widget) => widget.tabId === tabId)
      .map((widget) => widget.position) ?? [0];
    return Math.max(-1, ...positions) + 1;
  }

  private readonly cellCallbacks: BoardWidgetCellCallbacks = {
    appViewGeneration: () => this.callbacks?.appViewGeneration ?? 0,
    grant: async (name: string, decision: BoardGrantDecision) => {
      if (!this.callbacks) {
        return;
      }
      const sessionKey = this.snapshot?.sessionKey;
      await this.callbacks.grant(name, decision);
      if (sessionKey === this.snapshot?.sessionKey) {
        this.announce(
          decision === "granted"
            ? t("board.announcement.granted")
            : t("board.announcement.rejected"),
        );
      }
    },
    movePointerDown: (widget, event) => this.beginGesture("move", widget, event),
    resizePointerDown: (widget, event) => this.beginGesture("resize", widget, event),
    moveToTab: async (widget, tabId) =>
      this.applyOps(
        [
          {
            kind: "widget_move",
            name: widget.name,
            tabId,
            position: this.nextPosition(tabId),
          },
        ],
        t("board.announcement.moved", { title: widget.title || widget.name }),
      ),
    resizeTo: async (widget, w, h) =>
      this.applyOps(
        [{ kind: "widget_resize", name: widget.name, sizeW: w, sizeH: h, heightMode: "fixed" }],
        t("board.announcement.resized", { title: widget.title || widget.name }),
      ),
    setHeightMode: async (widget, mode) => {
      // Pinning keeps the currently rendered auto height, not the stale stored
      // sizeH, so "fixed" freezes exactly what the user sees.
      const sizeH =
        mode === "fixed"
          ? effectiveBoardWidgetRows(
              widget,
              this.contentHeights.get(widget.name),
              widget.name === this.pageWidgetName ? 0 : boardChromeRowPx(),
            )
          : widget.sizeH;
      await this.applyOps(
        [
          {
            kind: "widget_resize",
            name: widget.name,
            sizeW: widget.sizeW,
            sizeH,
            heightMode: mode,
          },
        ],
        t("board.announcement.resized", { title: widget.title || widget.name }),
      );
    },
    reportContentHeight: (name, height) => {
      const widget = this.snapshot?.widgets.find((candidate) => candidate.name === name);
      if (!widget || widget.contentKind !== "html") {
        return;
      }
      // Any pixel change matters: the cell renders the exact reported height,
      // not just the quantized row span.
      if (this.contentHeights.get(name) !== height) {
        this.contentHeights.set(name, height);
        this.requestUpdate();
      }
    },
    remove: async (widget) =>
      this.applyOps(
        [{ kind: "widget_remove", name: widget.name }],
        t("board.announcement.removed", { title: widget.title || widget.name }),
      ),
    nudge: async (widget, direction) => this.nudgeWidget(widget, direction),
    focus: (widget, direction) => this.focusWidget(widget, direction),
    focusChanged: (name) => {
      this.focusName = name;
    },
    frameLoadFailed: async (name) => this.callbacks?.frameLoadFailed?.(name),
    widgetAppView: async (name, revision) =>
      (await this.callbacks?.widgetAppView?.(name, revision)) ?? {
        status: "stale",
        error: "MCP App view unavailable",
      },
    refreshWidgetAppView: async (name, revision) =>
      (await this.callbacks?.refreshWidgetAppView?.(name, revision)) ?? {
        status: "stale",
        error: "MCP App view unavailable",
      },
  };

  selectPageWidgetMenuItem(name: string, revision: number, value: string): void {
    const widget = this.snapshot?.widgets.find((entry) => entry.name === name);
    if (
      !this.active ||
      !this.canMutate ||
      this.pageWidgetName !== name ||
      widget?.revision !== revision ||
      widget.tabId !== this.activeTabId
    ) {
      return;
    }
    const cell = [...this.querySelectorAll("openclaw-board-widget-cell")].find(
      (entry) => entry.pageChrome && entry.widget === widget,
    );
    cell?.selectMenuItem(value);
  }

  private beginGesture(
    mode: BoardPointerGesture["mode"],
    widget: BoardWidget,
    event: PointerEvent,
  ): void {
    if (
      !this.active ||
      !this.canMutate ||
      event.button !== 0 ||
      this.gesture ||
      this.mutationPending
    ) {
      return;
    }
    const snapshot = this.snapshot;
    const tabs = snapshot ? orderedBoardTabs(snapshot.tabs) : [];
    const tab = this.activeTab(tabs);
    if (!snapshot || !tab) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    try {
      (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointers and detached test targets cannot be captured.
    }
    const items = boardWidgetGridItems(orderedWidgets(snapshot, tab.tabId), this.contentHeights);
    this.gesture = {
      dropValid: false,
      mode,
      name: widget.name,
      originClientX: event.clientX,
      originClientY: event.clientY,
      originW: widget.sizeW,
      originH: effectiveBoardWidgetRows(
        widget,
        this.contentHeights.get(widget.name),
        boardChromeRowPx(),
      ),
      pointerId: event.pointerId,
      items,
    };
    this.previewItems = items;
    this.gestureName = widget.name;
    window.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    window.addEventListener("pointercancel", this.handlePointerCancel);
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }
    if (gesture.mode === "move") {
      const tabTarget = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-board-tab-id]");
      const candidateTabId =
        tabTarget?.closest("openclaw-board-view") === this
          ? (tabTarget.dataset.boardTabId ?? "")
          : "";
      const candidateIsValid =
        candidateTabId !== "" &&
        (this.snapshot?.tabs.some((tab) => tab.tabId === candidateTabId) ?? false);
      const currentTabId = this.snapshot
        ? this.activeTab(orderedBoardTabs(this.snapshot.tabs))?.tabId
        : this.activeTabId;
      this.hoverTabId = candidateIsValid && candidateTabId !== currentTabId ? candidateTabId : "";
      if (tabTarget) {
        this.previewItems = gesture.items;
        gesture.dropValid = this.hoverTabId !== "";
        return;
      }
      const grid = this.querySelector<HTMLElement>(".board-grid");
      const pointerElement = document.elementFromPoint(event.clientX, event.clientY);
      if (!grid || pointerElement?.closest(".board-grid") !== grid) {
        this.hoverTabId = "";
        this.previewItems = gesture.items;
        gesture.dropValid = false;
        return;
      }
      gesture.dropValid = true;
      const bounds = grid.getBoundingClientRect();
      const columnWidth = Math.max(
        1,
        (bounds.width - BOARD_GRID_GAP * (BOARD_GRID_COLUMNS - 1)) / BOARD_GRID_COLUMNS,
      );
      // Resolve both the visible target and reorder against the current preview;
      // a card moving under the pointer must not undo the drop on pointerup.
      const items = this.previewItems ?? gesture.items;
      const targetName = pointerElement?.closest<
        HTMLElementTagNameMap["openclaw-board-widget-cell"]
      >("openclaw-board-widget-cell")?.widget?.name;
      this.previewItems = previewDrag(items, gesture.name, {
        name: targetName,
        x: Math.floor((event.clientX - bounds.left) / (columnWidth + BOARD_GRID_GAP)),
        y: Math.floor((event.clientY - bounds.top) / (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP)),
      });
      return;
    }

    const grid = this.querySelector<HTMLElement>(".board-grid");
    const bounds = grid?.getBoundingClientRect();
    const columnWidth = bounds
      ? Math.max(1, (bounds.width - BOARD_GRID_GAP * (BOARD_GRID_COLUMNS - 1)) / BOARD_GRID_COLUMNS)
      : BOARD_GRID_ROW_HEIGHT;
    const deltaW = Math.round(
      (event.clientX - gesture.originClientX) / (columnWidth + BOARD_GRID_GAP),
    );
    const deltaH = Math.round(
      (event.clientY - gesture.originClientY) / (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP),
    );
    this.previewItems = resize(
      gesture.items,
      gesture.name,
      gesture.originW + deltaW,
      gesture.originH + deltaH,
    );
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }
    this.handlePointerMove(event);
    const previewItems = this.previewItems;
    const hoverTabId = this.hoverTabId;
    this.cancelGesture();
    const widget = this.snapshot?.widgets.find((entry) => entry.name === gesture.name);
    if (!widget) {
      return;
    }
    if (gesture.mode === "move") {
      if (!gesture.dropValid) {
        return;
      }
      const position = hoverTabId
        ? this.nextPosition(hoverTabId)
        : (previewItems?.find((item) => item.name === gesture.name)?.order ?? widget.position);
      if (!hoverTabId && position === widget.position) {
        return;
      }
      void this.applyOps(
        [
          {
            kind: "widget_move",
            name: gesture.name,
            ...(hoverTabId ? { tabId: hoverTabId } : {}),
            position,
          },
        ],
        t("board.announcement.moved", { title: widget.title || widget.name }),
      ).catch(() => undefined);
      return;
    }
    const resized = previewItems?.find((item) => item.name === gesture.name);
    if (resized && (resized.w !== gesture.originW || resized.h !== gesture.originH)) {
      void this.applyOps(
        [
          {
            kind: "widget_resize",
            name: gesture.name,
            sizeW: resized.w,
            sizeH: resized.h,
            heightMode: "fixed",
          },
        ],
        t("board.announcement.resized", { title: widget.title || widget.name }),
      ).catch(() => undefined);
    }
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (this.gesture && event.pointerId === this.gesture.pointerId) {
      this.cancelGesture();
    }
  };

  private cancelGesture(): void {
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerCancel);
    this.gesture = null;
    this.previewItems = null;
    this.gestureName = "";
    this.hoverTabId = "";
  }

  private async nudgeWidget(widget: BoardWidget, direction: BoardGridDirection): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    const items = boardWidgetGridItems(orderedWidgets(snapshot, widget.tabId), this.contentHeights);
    const moved = nudge(items, widget.name, direction).find((item) => item.name === widget.name);
    if (!moved || moved.order === widget.position) {
      return;
    }
    await this.applyOps(
      [{ kind: "widget_move", name: widget.name, position: moved.order }],
      t("board.announcement.moved", { title: widget.title || widget.name }),
    );
  }

  private focusWidget(widget: BoardWidget, direction: BoardGridDirection): void {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return;
    }
    const widgets = orderedWidgets(snapshot, widget.tabId);
    const index = widgets.findIndex((entry) => entry.name === widget.name);
    if (index < 0) {
      return;
    }
    const offset = direction === "left" || direction === "up" ? -1 : 1;
    const target = widgets[Math.max(0, Math.min(index + offset, widgets.length - 1))];
    if (!target || target.name === widget.name) {
      return;
    }
    this.focusName = target.name;
    void this.updateComplete.then(() => {
      const cell = [...this.querySelectorAll("openclaw-board-widget-cell")].find(
        (entry) => entry.widget?.name === target.name,
      );
      cell?.querySelector<HTMLElement>(".board-widget")?.focus();
    });
  }

  private readonly handleTabShow = (event: CustomEvent<{ name: string }>): void => {
    const tabs = this.snapshot ? orderedBoardTabs(this.snapshot.tabs) : [];
    const currentTabId = this.activeTab(tabs)?.tabId ?? this.activeTabId;
    if (event.detail.name !== currentTabId && tabs.some((tab) => tab.tabId === event.detail.name)) {
      this.callbacks?.selectTab(event.detail.name);
    }
  };

  private readonly handleOverflowSelect = (
    event: CustomEvent<{ item: { value?: string } }>,
  ): void => {
    const tabId = event.detail.item.value;
    if (tabId && this.snapshot?.tabs.some((tab) => tab.tabId === tabId)) {
      this.callbacks?.selectTab(tabId);
    }
  };

  private renderGrid(
    widgets: readonly BoardWidget[],
    tabs: readonly BoardTab[],
    sessionKey: string,
    activeTabId: string,
  ): TemplateResult {
    const rects = tabs.flatMap((tab) => {
      const tabWidgets = widgets.filter((widget) => widget.tabId === tab.tabId);
      const items =
        (tab.tabId === activeTabId ? this.previewItems : null) ??
        boardWidgetGridItems(
          tabWidgets,
          this.contentHeights,
          this.fitAutoContent,
          this.pageWidgetName,
        );
      return layout(items, this.fitAutoContent ? BOARD_DOCUMENT_AUTO_MAX_ROWS : undefined);
    });
    const activeNames = new Set(
      widgets.filter((widget) => widget.tabId === activeTabId).map((widget) => widget.name),
    );
    const activeRects = rects.filter((rect) => activeNames.has(rect.name));
    for (const rect of rects) {
      if (!this.stableCellOrder.has(rect.name)) {
        this.stableCellOrder.set(rect.name, this.stableCellOrderSequence);
        this.stableCellOrderSequence += 1;
      }
    }
    const stableRects = rects.toSorted(
      (left, right) =>
        (this.stableCellOrder.get(left.name) ?? 0) - (this.stableCellOrder.get(right.name) ?? 0) ||
        left.name.localeCompare(right.name),
    );
    const logicalPosition = new Map(activeRects.map((rect, index) => [rect.name, index]));
    const focusName = activeRects.some((rect) => rect.name === this.focusName)
      ? this.focusName
      : (activeRects[0]?.name ?? "");
    const widgetByName = new Map(widgets.map((widget) => [widget.name, widget]));
    return html`
      <div
        class="board-grid"
        role="list"
        aria-label=${t("board.gridLabel")}
        ?hidden=${activeRects.length === 0}
      >
        ${repeat(
          stableRects,
          (rect) =>
            JSON.stringify([this.session.agentId, this.session.sessionKey, sessionKey, rect.name]),
          (rect) => {
            const widget = widgetByName.get(rect.name);
            if (!widget) {
              return nothing;
            }
            return html`
              <openclaw-board-widget-cell
                ?hidden=${!activeNames.has(widget.name)}
                ?inert=${!activeNames.has(widget.name)}
                .widget=${widget}
                .rect=${rect}
                .contentHeightPx=${this.contentHeights.get(widget.name)}
                .fitAutoContent=${this.fitAutoContent}
                .pageChrome=${widget.name === this.pageWidgetName}
                .tabs=${tabs}
                .session=${this.session}
                .sessionKey=${sessionKey}
                .widgetFrameUrl=${this.widgetFrameUrl}
                .callbacks=${this.cellCallbacks}
                .active=${this.active && activeNames.has(widget.name)}
                .bridgeEnabled=${this.bridgeEnabled}
                .dragging=${widget.name === this.gestureName}
                .focusTabIndex=${widget.name === focusName ? 0 : -1}
                .positionInSet=${(logicalPosition.get(widget.name) ?? 0) + 1}
                .setSize=${activeRects.length}
                .busy=${this.mutationPending}
                .canMutate=${this.canMutate}
                .canGrant=${this.canGrant}
              ></openclaw-board-widget-cell>
            `;
          },
        )}
        ${
          this.gesture?.mode === "move"
            ? html`<div class="board-grid__append-zone" aria-hidden="true"></div>`
            : nothing
        }
      </div>
      ${
        activeRects.length === 0
          ? html`
              <div class="board-empty" data-test-id="board-empty">
                <span class="board-empty__mark" aria-hidden="true">＋</span>
                <strong>${t("board.emptyTitle")}</strong>
                <span>${t("board.emptyHint")}</span>
              </div>
            `
          : nothing
      }
    `;
  }

  override render() {
    const snapshot = this.snapshot;
    if (!snapshot) {
      return nothing;
    }
    const tabs = orderedBoardTabs(snapshot.tabs);
    const activeTab = this.activeTab(tabs);
    const activeTabId = activeTab?.tabId ?? this.activeTabId;
    const widgets = activeTab ? orderedWidgets(snapshot, activeTab.tabId) : [];
    if (activeTab) {
      this.visitedTabs.add(activeTabId);
    }
    // Moving a mounted widget to an unvisited tab must not reload its document.
    const retainedWidgets = snapshot.widgets.filter(
      (widget) => this.visitedTabs.has(widget.tabId) || this.stableCellOrder.has(widget.name),
    );
    const fullWidth = widgets.length === 1 && widgets[0]?.sizeW === BOARD_GRID_COLUMNS;
    const page =
      fullWidth &&
      (widgets[0]?.pluginKind === "session:website" ||
        widgets[0]?.pluginKind === "browser:dashboard");
    return html`
      <section
        class=${`board-view ${fullWidth ? "board-view--single-full-width" : ""} ${page ? "board-view--page" : ""}`}
        aria-label=${t("board.label")}
      >
        ${renderBoardTabs({
          tabs,
          activeTabId,
          hoverTabId: this.hoverTabId,
          onTabShow: this.handleTabShow,
          onOverflowSelect: this.handleOverflowSelect,
        })}
        ${this.renderGrid(retainedWidgets, tabs, snapshot.sessionKey, activeTabId)}
        ${
          this.actionError
            ? html`<div class="board-view__error" role="alert">${this.actionError}</div>`
            : nothing
        }
        <div class="board-announcer" aria-live="polite" aria-atomic="true">
          ${
            this.announcement
              ? keyed(
                  this.announcementRevision,
                  html`<span data-announcement-revision=${this.announcementRevision}
                    >${this.announcement}</span
                  >`,
                )
              : nothing
          }
        </div>
      </section>
    `;
  }
}

if (!customElements.get("openclaw-board-view")) {
  customElements.define("openclaw-board-view", OpenClawBoardView);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-view": OpenClawBoardView;
  }
}
