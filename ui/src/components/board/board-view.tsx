import type { BoardGetParams } from "@openclaw/gateway-protocol";
import type { JSX as SolidJSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
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
import { t } from "../../lib/reactive/i18n.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import { PanelLoadingSkeleton } from "../solid/panel-loading-skeleton.tsx";
import "../../styles/board.css";
import "../web-awesome-tabs.ts";
import "../web-awesome.ts";
import { BoardTabs, orderedBoardTabs } from "./board-tabs.tsx";
import {
  BoardWidgetCell,
  type BoardWidgetCellCallbacks,
  type BoardWidgetCellProps,
} from "./board-widget-cell.ts";

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

export type BoardViewProps = {
  session: BoardGetParams;
  snapshot?: BoardSnapshot;
  activeTabId: string;
  widgetFrameUrl?: BoardWidgetFrameUrl;
  callbacks?: BoardViewCallbacks;
  active: boolean;
  bridgeEnabled: boolean;
  canMutate: boolean;
  canGrant: boolean;
  fitAutoContent: boolean;
  pageWidgetName: string;
};

type BoardViewMethods = {
  selectPageWidgetMenuItem(name: string, revision: number, value: string): void;
  teardown(): Promise<void>;
};
type BoardViewElement = SolidBridgeElement<BoardViewProps, BoardViewMethods>;

// Local interaction state is synchronous: pointerup consumes the final pointermove,
// and a second mutation is rejected before Solid's next rendering commit.
class BoardViewState {
  previewItems: BoardGridItem[] | null = null;
  gestureName = "";
  hoverTabId = "";
  announcement = "";
  announcementRevision = 0;
  actionError = "";
  focusName = "";
  mutationPending = false;
  initialLoading = true;
  gesture: BoardPointerGesture | null = null;
  private mutationRequestId = 0;
  readonly visitedTabs = new Set<string>();
  readonly contentHeights = new Map<string, number>();
  private previous?: BoardViewProps;

  constructor(
    readonly props: BoardViewProps,
    readonly host: BoardViewElement,
    readonly requestUpdate: () => void,
  ) {}

  sync(): void {
    const previous = this.previous;
    const next = this.props;
    this.previous = { ...next };
    const snapshotChanged = previous?.snapshot !== next.snapshot;
    const ownerChanged =
      previous?.session.agentId !== next.session.agentId ||
      previous?.session.sessionKey !== next.session.sessionKey ||
      previous?.snapshot?.sessionKey !== next.snapshot?.sessionKey;
    if (ownerChanged) {
      this.initialLoading = true;
      this.host.scrollTop = 0;
      this.visitedTabs.clear();
      this.contentHeights.clear();
      this.mutationRequestId += 1;
      this.mutationPending = false;
      this.focusName = "";
    }
    if (snapshotChanged) {
      this.actionError = "";
      const previousByName = new Map(
        previous?.snapshot?.widgets.map((widget) => [widget.name, widget]),
      );
      const currentByName = new Map(next.snapshot?.widgets.map((widget) => [widget.name, widget]));
      for (const name of this.contentHeights.keys()) {
        const current = currentByName.get(name);
        if (
          !current ||
          current.contentKind !== "html" ||
          previousByName.get(name)?.revision !== current.revision
        )
          this.contentHeights.delete(name);
      }
      const tabIds = new Set(next.snapshot?.tabs.map((tab) => tab.tabId));
      for (const tabId of this.visitedTabs) if (!tabIds.has(tabId)) this.visitedTabs.delete(tabId);
    }
    if (previous?.activeTabId !== next.activeTabId) this.focusName = "";
    if (
      this.gesture &&
      (snapshotChanged ||
        previous?.activeTabId !== next.activeTabId ||
        previous?.pageWidgetName !== next.pageWidgetName ||
        !next.active)
    )
      this.cancelGesture();
  }

  disconnect(): void {
    this.cancelGesture();
  }

  async teardown(): Promise<void> {
    this.cancelGesture();
    await Promise.all(
      [...this.host.querySelectorAll("openclaw-board-widget-cell")].map((cell) => cell.teardown()),
    );
  }

  readonly reconcileInitialPresentation = (): void => {
    if (!this.initialLoading || !this.props.snapshot) return;
    const cells = [...this.host.querySelectorAll("openclaw-board-widget-cell")].filter(
      (cell) => !cell.hidden,
    );
    if (cells.every((cell) => cell.presentationReady)) {
      this.initialLoading = false;
      this.requestUpdate();
    }
  };
  activeTab(tabs: readonly BoardTab[]): BoardTab | undefined {
    return tabs.find((tab) => tab.tabId === this.props.activeTabId) ?? tabs[0];
  }

  private announce(message: string): void {
    this.announcement = message;
    this.announcementRevision += 1;
    this.requestUpdate();
  }

  private async applyOps(ops: BoardOp[], announcement: string): Promise<void> {
    if (!this.props.callbacks) {
      return;
    }
    if (this.mutationPending) {
      throw new Error(t("board.actionInProgress"));
    }
    const sessionKey = this.props.snapshot?.sessionKey;
    const requestId = this.mutationRequestId + 1;
    this.mutationRequestId = requestId;
    this.mutationPending = true;
    this.actionError = "";
    this.requestUpdate();
    try {
      await this.props.callbacks.applyOps(ops);
      if (requestId === this.mutationRequestId && sessionKey === this.props.snapshot?.sessionKey) {
        this.announce(announcement);
      }
    } catch (error) {
      if (requestId === this.mutationRequestId && sessionKey === this.props.snapshot?.sessionKey) {
        this.actionError = t("board.actionFailed");
        this.announce(this.actionError);
      }
      throw error;
    } finally {
      if (requestId === this.mutationRequestId) {
        this.mutationPending = false;
        this.requestUpdate();
      }
    }
  }

  private nextPosition(tabId: string): number {
    const positions = this.props.snapshot?.widgets
      .filter((widget) => widget.tabId === tabId)
      .map((widget) => widget.position) ?? [0];
    return Math.max(-1, ...positions) + 1;
  }

  private moveWidget(widget: BoardWidget, position: number, tabId?: string): Promise<void> {
    return this.applyOps(
      [
        {
          kind: "widget_move",
          name: widget.name,
          position,
          ...(tabId === undefined ? {} : { tabId }),
        },
      ],
      t("board.announcement.moved", { title: widget.title || widget.name }),
    );
  }

  readonly cellCallbacks: BoardWidgetCellCallbacks = {
    appViewGeneration: () => this.props.callbacks?.appViewGeneration ?? 0,
    grant: async (name: string, decision: BoardGrantDecision) => {
      if (!this.props.callbacks) {
        return;
      }
      const sessionKey = this.props.snapshot?.sessionKey;
      await this.props.callbacks.grant(name, decision);
      if (sessionKey === this.props.snapshot?.sessionKey) {
        this.announce(
          decision === "granted"
            ? t("board.announcement.granted")
            : t("board.announcement.rejected"),
        );
      }
    },
    movePointerDown: (widget, event) => this.beginGesture("move", widget, event),
    resizePointerDown: (widget, event) => this.beginGesture("resize", widget, event),
    moveToTab: (widget, tabId) => this.moveWidget(widget, this.nextPosition(tabId), tabId),
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
              widget.name === this.props.pageWidgetName ? 0 : boardChromeRowPx(),
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
      const widget = this.props.snapshot?.widgets.find((candidate) => candidate.name === name);
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
      this.requestUpdate();
    },
    frameLoadFailed: async (name) => this.props.callbacks?.frameLoadFailed?.(name),
    widgetAppView: async (name, revision) =>
      (await this.props.callbacks?.widgetAppView?.(name, revision)) ?? {
        status: "stale",
        error: "MCP App view unavailable",
      },
    refreshWidgetAppView: async (name, revision) =>
      (await this.props.callbacks?.refreshWidgetAppView?.(name, revision)) ?? {
        status: "stale",
        error: "MCP App view unavailable",
      },
  };

  selectPageWidgetMenuItem(name: string, revision: number, value: string): void {
    const widget = this.props.snapshot?.widgets.find((entry) => entry.name === name);
    if (
      !this.props.active ||
      !this.props.canMutate ||
      this.props.pageWidgetName !== name ||
      widget?.revision !== revision ||
      widget.tabId !== this.props.activeTabId
    ) {
      return;
    }
    const cell = [...this.host.querySelectorAll("openclaw-board-widget-cell")].find(
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
      !this.props.active ||
      !this.props.canMutate ||
      event.button !== 0 ||
      this.gesture ||
      this.mutationPending
    ) {
      return;
    }
    const snapshot = this.props.snapshot;
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
    this.requestUpdate();
  }

  private readonly handlePointerMove = (event: PointerEvent): void => {
    this.requestUpdate();
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }
    if (gesture.mode === "move") {
      const tabTarget = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-board-tab-id]");
      const candidateTabId =
        tabTarget?.closest("openclaw-board-view") === this.host
          ? (tabTarget?.dataset.boardTabId ?? "")
          : "";
      const candidateIsValid =
        candidateTabId !== "" &&
        (this.props.snapshot?.tabs.some((tab) => tab.tabId === candidateTabId) ?? false);
      const currentTabId = this.props.snapshot
        ? this.activeTab(orderedBoardTabs(this.props.snapshot.tabs))?.tabId
        : this.props.activeTabId;
      this.hoverTabId = candidateIsValid && candidateTabId !== currentTabId ? candidateTabId : "";
      if (tabTarget) {
        this.previewItems = gesture.items;
        gesture.dropValid = this.hoverTabId !== "";
        return;
      }
      const grid = this.host.querySelector<HTMLElement>(".board-grid");
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

    const grid = this.host.querySelector<HTMLElement>(".board-grid");
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
    const widget = this.props.snapshot?.widgets.find((entry) => entry.name === gesture.name);
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
      void this.moveWidget(widget, position, hoverTabId || undefined).catch(() => undefined);
      return;
    }
    const resized = previewItems?.find((item) => item.name === gesture.name);
    if (resized && (resized.w !== gesture.originW || resized.h !== gesture.originH)) {
      void this.cellCallbacks.resizeTo(widget, resized.w, resized.h).catch(() => undefined);
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
    this.requestUpdate();
  }

  private async nudgeWidget(widget: BoardWidget, direction: BoardGridDirection): Promise<void> {
    const snapshot = this.props.snapshot;
    if (!snapshot) {
      return;
    }
    const items = boardWidgetGridItems(orderedWidgets(snapshot, widget.tabId), this.contentHeights);
    const moved = nudge(items, widget.name, direction).find((item) => item.name === widget.name);
    if (!moved || moved.order === widget.position) {
      return;
    }
    await this.moveWidget(widget, moved.order);
  }

  private focusWidget(widget: BoardWidget, direction: BoardGridDirection): void {
    const snapshot = this.props.snapshot;
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
    this.requestUpdate();
    queueMicrotask(() => {
      const cell = [...this.host.querySelectorAll("openclaw-board-widget-cell")].find(
        (entry) => entry.widget?.name === target.name,
      );
      cell?.querySelector<HTMLElement>(".board-widget")?.focus();
    });
  }

  readonly handleTabShow = (event: CustomEvent<{ name: string }>): void => {
    const tabs = this.props.snapshot ? orderedBoardTabs(this.props.snapshot.tabs) : [];
    const currentTabId = this.activeTab(tabs)?.tabId ?? this.props.activeTabId;
    if (event.detail.name !== currentTabId && tabs.some((tab) => tab.tabId === event.detail.name)) {
      this.props.callbacks?.selectTab(event.detail.name);
    }
  };

  readonly handleOverflowSelect = (event: CustomEvent<{ item: { value?: string } }>): void => {
    const tabId = event.detail.item.value;
    if (tabId && this.props.snapshot?.tabs.some((tab) => tab.tabId === tabId)) {
      this.props.callbacks?.selectTab(tabId);
    }
  };
}

const views = new WeakMap<HTMLElement, BoardViewState>();
type CellEntry = {
  key: string;
  present: boolean;
  retiring?: boolean;
  element?: HTMLElementTagNameMap["openclaw-board-widget-cell"];
  options: BoardWidgetCellProps;
};

function BoardViewContent(props: BoardViewProps, host: BoardViewElement) {
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const state = new BoardViewState(props, host, () => setRevision((value) => value + 1));
  views.set(host, state);
  // Grid coordinates change; map insertion order keeps iframe nodes in place.
  const entries = new Map<string, CellEntry>();
  let disposed = false;
  const cellKey = (name: string) =>
    JSON.stringify([
      props.session.agentId,
      props.session.sessionKey,
      props.snapshot?.sessionKey,
      name,
    ]);
  const view = createMemo(() => {
    revision();
    state.sync();
    const snapshot = props.snapshot;
    const tabs = orderedBoardTabs(snapshot?.tabs ?? []);
    const activeTab = state.activeTab(tabs);
    const activeTabId = activeTab?.tabId ?? props.activeTabId;
    const activeWidgets = snapshot && activeTab ? orderedWidgets(snapshot, activeTabId) : [];
    if (activeTab) state.visitedTabs.add(activeTabId);
    // A widget moved to an unvisited tab keeps its already mounted document.
    const widgets = (snapshot?.widgets ?? []).filter(
      (widget) => state.visitedTabs.has(widget.tabId) || entries.has(cellKey(widget.name)),
    );
    const rects = tabs.flatMap((tab) =>
      layout(
        (tab.tabId === activeTabId ? state.previewItems : null) ??
          boardWidgetGridItems(
            widgets.filter((widget) => widget.tabId === tab.tabId),
            state.contentHeights,
            props.fitAutoContent,
            props.pageWidgetName,
          ),
        props.fitAutoContent ? BOARD_DOCUMENT_AUTO_MAX_ROWS : undefined,
      ),
    );
    const activeNames = new Set(activeWidgets.map((widget) => widget.name));
    const activeRects = rects.filter((rect) => activeNames.has(rect.name));
    const fullWidth = activeWidgets.length === 1 && activeWidgets[0]?.sizeW === BOARD_GRID_COLUMNS;
    const page =
      fullWidth &&
      (activeWidgets[0]?.name === props.pageWidgetName ||
        activeWidgets[0]?.pluginKind === "session:website" ||
        activeWidgets[0]?.pluginKind === "browser:dashboard");
    const loading = !snapshot || state.initialLoading;
    const widgetsByName = new Map(widgets.map((widget) => [widget.name, widget]));
    const positions = new Map(activeRects.map((rect, index) => [rect.name, index]));
    const focusName = activeRects.some((rect) => rect.name === state.focusName)
      ? state.focusName
      : (activeRects[0]?.name ?? "");
    for (const entry of entries.values()) entry.present = false;
    for (const rect of rects) {
      const key = cellKey(rect.name);
      const visible = activeNames.has(rect.name);
      entries.set(key, {
        ...entries.get(key),
        key,
        present: true,
        options: {
          widget: widgetsByName.get(rect.name),
          rect,
          contentHeightPx: state.contentHeights.get(rect.name),
          fitAutoContent: props.fitAutoContent,
          pageChrome: rect.name === props.pageWidgetName,
          tabs,
          session: props.session,
          sessionKey: snapshot?.sessionKey ?? "",
          widgetFrameUrl: props.widgetFrameUrl,
          callbacks: state.cellCallbacks,
          active: props.active && visible,
          bridgeEnabled: props.bridgeEnabled,
          dragging: rect.name === state.gestureName,
          focusTabIndex: rect.name === focusName ? 0 : -1,
          positionInSet: (positions.get(rect.name) ?? 0) + 1,
          setSize: activeRects.length,
          busy: state.mutationPending,
          canMutate: props.canMutate,
          canGrant: props.canGrant,
          loadingCovered: loading,
        },
      });
    }
    for (const [key, entry] of entries) {
      if (entry.present) continue;
      if (entry.options.widget?.contentKind !== "mcp-app" || !entry.element) {
        entries.delete(key);
      } else if (!entry.retiring) {
        // Keep the last binding connected until the app's bounded teardown completes.
        entries.set(key, {
          ...entry,
          retiring: true,
          options: { ...entry.options, active: false },
        });
        const element = entry.element;
        const finish = () => {
          if (disposed) return;
          const current = entries.get(key);
          if (current?.present) {
            current.retiring = false;
            element.restartAfterTeardown();
          } else entries.delete(key);
          state.requestUpdate();
        };
        void element.teardown().then(finish, finish);
      }
    }
    return {
      tabs,
      activeTabId,
      activeNames,
      empty: activeRects.length === 0,
      fullWidth,
      page,
      loading,
      cells: [...entries.values()],
      state,
    };
  });
  createEffect(
    () => view(),
    (current) => {
      host.toggleAttribute("data-initial-loading", current.loading);
      state.reconcileInitialPresentation();
    },
  );
  onSettled(() => {
    // Hybrid devices move the chrome in/out of flow when pointer capability changes.
    const pointer =
      typeof window.matchMedia === "function" ? window.matchMedia(FINE_POINTER_QUERY) : null;
    pointer?.addEventListener("change", state.requestUpdate);
    return () => pointer?.removeEventListener("change", state.requestUpdate);
  });
  onCleanup(() => {
    disposed = true;
    state.disconnect();
    views.delete(host);
  });

  return (
    <>
      <Show when={view().loading}>
        <PanelLoadingSkeleton
          variant="board"
          label={t("common.loading")}
          compact={false}
          overlay={true}
        />
      </Show>
      <section
        class={[
          "board-view",
          {
            "board-view--single-full-width": view().fullWidth,
            "board-view--page": view().page,
            "board-view--loading": view().loading,
          },
        ]}
        aria-label={t("board.label")}
        aria-busy={view().loading ? "true" : "false"}
        inert={view().loading}
        onOpenclaw-board-widget-presentation={state.reconcileInitialPresentation}
      >
        <BoardTabs
          tabs={view().tabs}
          activeTabId={view().activeTabId}
          hoverTabId={view().state.hoverTabId}
          onTabShow={state.handleTabShow}
          onOverflowSelect={state.handleOverflowSelect}
        />
        <Show when={Boolean(props.snapshot) || view().cells.length > 0}>
          <div
            class="board-grid"
            role="list"
            aria-label={t("board.gridLabel")}
            hidden={view().empty}
          >
            <For each={view().cells} keyed={(entry) => entry.key}>
              {(entry) => (
                <BoardWidgetCell
                  {...entry().options}
                  ref={(element) => {
                    const current = entries.get(entry().key);
                    if (current) current.element = element;
                  }}
                  hidden={!entry().present || !view().activeNames.has(entry().options.widget!.name)}
                  inert={!entry().present || !view().activeNames.has(entry().options.widget!.name)}
                />
              )}
            </For>
            <Show when={view().state.gesture?.mode === "move"}>
              <div class="board-grid__append-zone" aria-hidden="true" />
            </Show>
          </div>
          <Show when={view().empty}>
            <div class="board-empty" data-test-id="board-empty">
              <span class="board-empty__mark" aria-hidden="true">
                ＋
              </span>
              <strong>{t("board.emptyTitle")}</strong>
              <span>{t("board.emptyHint")}</span>
            </div>
          </Show>
        </Show>
        <Show when={view().state.actionError}>
          <div class="board-view__error" role="alert">
            {view().state.actionError}
          </div>
        </Show>
        <div class="board-announcer" aria-live="polite" aria-atomic="true">
          <Show when={view().state.announcementRevision || undefined} keyed>
            {(announcementRevision) => (
              <span data-announcement-revision={announcementRevision}>
                {view().state.announcement}
              </span>
            )}
          </Show>
        </div>
      </section>
    </>
  );
}

export const BoardView = defineSolidBridge<BoardViewProps, BoardViewMethods>(
  "openclaw-board-view",
  BoardViewContent,
  {
    properties: {
      session: { default: { sessionKey: "" }, attribute: false },
      snapshot: { default: undefined, attribute: false },
      activeTabId: { default: "", attribute: false },
      widgetFrameUrl: { default: undefined, attribute: false },
      callbacks: { default: undefined, attribute: false },
      active: { default: true, type: Boolean },
      bridgeEnabled: { default: true, type: Boolean },
      canMutate: { default: true, type: Boolean },
      canGrant: { default: true, type: Boolean },
      fitAutoContent: { default: false, type: Boolean },
      pageWidgetName: { default: "", attribute: false },
    },
    methods: {
      selectPageWidgetMenuItem: (
        host: BoardViewElement,
        name: string,
        revision: number,
        value: string,
      ) => views.get(host)?.selectPageWidgetMenuItem(name, revision, value),
      teardown: async (host: BoardViewElement) => {
        await views.get(host)?.teardown();
      },
    },
  },
);

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-board-view": BoardViewElement;
  }
}

type BoardViewAttributes = SolidJSX.HTMLAttributes<BoardViewElement> & {
  [Key in keyof BoardViewProps as `prop:${Key}`]?: BoardViewProps[Key];
};

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-board-view": BoardViewAttributes;
    }
  }
}
