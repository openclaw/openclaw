import type { BoardGetParams } from "@openclaw/gateway-protocol";
import { createMemo, createStore, onSettled } from "solid-js";
import {
  BOARD_GRID_COLUMNS,
  BOARD_GRID_GAP,
  BOARD_GRID_ROW_HEIGHT,
  boardChromeRowPx,
  boardWidgetGridItems,
  effectiveBoardWidgetRows,
  nudge,
  previewDrag,
  resize,
  type BoardGridItem,
} from "../../lib/board/grid.ts";
import type { BoardOp, BoardSnapshot, BoardWidget } from "../../lib/board/types.ts";
import type { BoardViewCallbacks, BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import type { SolidBridgeElement } from "../../lib/solid-bridge.ts";
import { orderedBoardTabs } from "./board-tabs.tsx";
import type { BoardWidgetCellMethods } from "./board-widget-cell-options.ts";
import {
  boardWidgetPresentationReady,
  type BoardWidgetCellCallbacks,
  type BoardWidgetCellProps,
} from "./board-widget-cell.ts";

type BoardPointerGesture = {
  mode: "move" | "resize";
  name: string;
  originClientX: number;
  originClientY: number;
  originW: number;
  originH: number;
  pointerId: number;
  items: BoardGridItem[];
};

export function orderedWidgets(snapshot: BoardSnapshot, tabId: string): BoardWidget[] {
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

export type BoardViewMethods = {
  selectPageWidgetMenuItem(name: string, revision: number, value: string): void;
  teardown(): Promise<void>;
};
export type BoardViewElement = SolidBridgeElement<BoardViewProps, BoardViewMethods>;

export function createBoardViewState(
  props: BoardViewProps,
  host: BoardViewElement,
  cells: () => SolidBridgeElement<BoardWidgetCellProps, BoardWidgetCellMethods>[],
) {
  // Pointer identity and mutation admission must be visible within the same event turn.
  let gesture: BoardPointerGesture | null = null;
  let gestureListeners: (() => void)[] = [];
  let grid: HTMLElement | undefined;
  let mutationPending = false;
  let mutationRequestId = 0;
  let previous: BoardViewProps | undefined;
  const visitedTabs = new Set<string>();
  const tabs = createMemo(() => orderedBoardTabs(props.snapshot?.tabs ?? []));
  const activeTab = createMemo(
    () => tabs().find((tab) => tab.tabId === props.activeTabId) ?? tabs()[0],
  );
  const initialHeights: Record<string, { height: number; revision: number }> = {};
  const initial = {
    previewItems: new Array<BoardGridItem>(),
    gesture: { name: "", mode: "" },
    hoverTabId: "",
    announcement: "",
    announcementRevision: 0,
    mutationFailure: undefined,
    focusName: "",
    mutationPending: false,
    initialLoading: true,
    contentHeights: initialHeights,
  };
  type Presentation = Omit<typeof initial, "mutationFailure"> & {
    mutationFailure: { result: Promise<void> } | undefined;
  };
  const [presentation, update] = createStore<Presentation>(sync, initial);
  const contentHeights = { get: (name: string) => presentation.contentHeights[name]?.height };
  onSettled(() => stopGesture);

  function sync(local: Presentation): void {
    const before = previous;
    previous = { ...props };
    const snapshotChanged = before?.snapshot !== props.snapshot;
    const ownerChanged =
      before?.session.agentId !== props.session.agentId ||
      before?.session.sessionKey !== props.session.sessionKey ||
      before?.snapshot?.sessionKey !== props.snapshot?.sessionKey;
    if (ownerChanged) {
      local.initialLoading = true;
      host.scrollTop = 0;
      visitedTabs.clear();
      local.contentHeights = {};
      mutationRequestId += 1;
      mutationPending = local.mutationPending = false;
    }
    // Recovery reads can publish unchanged state after a failed mutation.
    if (ownerChanged || before?.snapshot?.revision !== props.snapshot?.revision) {
      local.mutationFailure = undefined;
    }
    if (snapshotChanged) {
      const currentByName = new Map(props.snapshot?.widgets.map((widget) => [widget.name, widget]));
      for (const name of Object.keys(local.contentHeights)) {
        const current = currentByName.get(name);
        if (
          !current ||
          current.contentKind !== "html" ||
          local.contentHeights[name]?.revision !== current.revision
        ) {
          delete local.contentHeights[name];
        }
      }
      const tabIds = new Set(props.snapshot?.tabs.map((tab) => tab.tabId));
      for (const tabId of visitedTabs) {
        if (!tabIds.has(tabId)) {
          visitedTabs.delete(tabId);
        }
      }
    }
    if (ownerChanged || before?.activeTabId !== props.activeTabId) {
      local.focusName = "";
    }
    if (
      gesture &&
      (snapshotChanged ||
        before?.activeTabId !== props.activeTabId ||
        before?.pageWidgetName !== props.pageWidgetName ||
        !props.active)
    ) {
      clearGesture(local);
    }
  }

  async function teardown(): Promise<void> {
    update(clearGesture);
    await Promise.all(cells().map((cell) => cell.teardown()));
  }

  // Readiness is sampled after a cell commit; this callback owns no subscription.
  const reconcileInitialPresentation = (): void => {
    if (
      presentation.initialLoading &&
      props.snapshot &&
      cells().every((cell) => cell.hidden || boardWidgetPresentationReady(cell))
    ) {
      update((local) => {
        local.initialLoading = false;
      });
    }
  };
  function announce(message: string): void {
    update((local) => {
      local.announcement = message;
      local.announcementRevision += 1;
    });
  }

  async function applyOps(ops: BoardOp[], announcement: string): Promise<void> {
    const callbacks = props.callbacks;
    if (!callbacks) {
      return;
    }
    if (mutationPending) {
      throw new Error(t("board.actionInProgress"));
    }
    const sessionKey = props.snapshot?.sessionKey;
    const requestId = ++mutationRequestId;
    mutationPending = true;
    // Child cells have independent bridge roots. Keep busy publication outside
    // an action so a held mutation cannot hold their disabled-control updates.
    update((local) => {
      local.mutationFailure = undefined;
      local.mutationPending = true;
    });
    const completion = (async () => {
      try {
        await callbacks.applyOps(ops);
        if (requestId === mutationRequestId && sessionKey === props.snapshot?.sessionKey) {
          announce(announcement);
        }
      } finally {
        if (requestId === mutationRequestId) {
          mutationPending = false;
          update((local) => {
            local.mutationPending = false;
          });
        }
      }
    })();
    // Observe only the settled rejection; pending reads would hold the shared
    // grid presentation and its cell lifecycle updates.
    void completion.catch(() => {
      if (requestId === mutationRequestId && sessionKey === props.snapshot?.sessionKey) {
        update((local) => {
          local.mutationFailure = { result: completion };
        });
        announce(t("board.actionFailed"));
      }
    });
    return completion;
  }

  function nextPosition(tabId: string): number {
    const positions = props.snapshot?.widgets
      .filter((widget) => widget.tabId === tabId)
      .map((widget) => widget.position) ?? [0];
    return Math.max(-1, ...positions) + 1;
  }

  function moveWidget(widget: BoardWidget, position: number, tabId?: string): Promise<void> {
    return applyOps(
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

  const cellCallbacks: BoardWidgetCellCallbacks = {
    presentationReady: reconcileInitialPresentation,
    appViewGeneration: () => props.callbacks?.appViewGeneration ?? 0,
    grant: async (name, decision) => {
      if (!props.callbacks) {
        return;
      }
      const sessionKey = props.snapshot?.sessionKey;
      await props.callbacks.grant(name, decision);
      if (sessionKey === props.snapshot?.sessionKey) {
        announce(
          decision === "granted"
            ? t("board.announcement.granted")
            : t("board.announcement.rejected"),
        );
      }
    },
    movePointerDown: (widget, event) => beginGesture("move", widget, event),
    resizePointerDown: (widget, event) => beginGesture("resize", widget, event),
    moveToTab: (widget, tabId) => moveWidget(widget, nextPosition(tabId), tabId),
    resizeTo: async (widget, w, h) =>
      applyOps(
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
              contentHeights.get(widget.name),
              widget.name === props.pageWidgetName ? 0 : boardChromeRowPx(),
            )
          : widget.sizeH;
      await applyOps(
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
      const widget = props.snapshot?.widgets.find((candidate) => candidate.name === name);
      if (!widget || widget.contentKind !== "html") {
        return;
      }
      // Any pixel change matters: the cell renders the exact reported height,
      // not just the quantized row span.
      update((local) => {
        if (local.contentHeights[name]?.height !== height) {
          local.contentHeights[name] = { height, revision: widget.revision };
        }
      });
    },
    remove: async (widget) =>
      applyOps(
        [{ kind: "widget_remove", name: widget.name }],
        t("board.announcement.removed", { title: widget.title || widget.name }),
      ),
    nudge: async (widget, direction) => {
      const snapshot = props.snapshot;
      if (!snapshot) {
        return;
      }
      const items = boardWidgetGridItems(orderedWidgets(snapshot, widget.tabId), contentHeights);
      const moved = nudge(items, widget.name, direction).find((item) => item.name === widget.name);
      if (!moved || moved.order === widget.position) {
        return;
      }
      await moveWidget(widget, moved.order);
    },
    focus: (widget, direction) => {
      const snapshot = props.snapshot;
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
      update((local) => {
        local.focusName = target.name;
      });
      queueMicrotask(() => {
        const cell = cells().find((entry) => entry.widget?.name === target.name);
        cell?.focusWidget();
      });
    },
    focusChanged: (name) => {
      update((local) => {
        local.focusName = name;
      });
    },
    frameLoadFailed: async (name) => props.callbacks?.frameLoadFailed?.(name),
    widgetAppView: async (name, revision) =>
      (await props.callbacks?.widgetAppView?.(name, revision)) ?? {
        status: "stale",
      },
    refreshWidgetAppView: async (name, revision) =>
      (await props.callbacks?.refreshWidgetAppView?.(name, revision)) ?? {
        status: "stale",
      },
  };

  function selectPageWidgetMenuItem(name: string, revision: number, value: string): void {
    const widget = props.snapshot?.widgets.find((entry) => entry.name === name);
    if (
      !props.active ||
      !props.canMutate ||
      props.pageWidgetName !== name ||
      widget?.revision !== revision ||
      widget.tabId !== props.activeTabId
    ) {
      return;
    }
    const cell = cells().find((entry) => entry.pageChrome && entry.widget === widget);
    cell?.selectMenuItem(value);
  }

  function beginGesture(
    mode: BoardPointerGesture["mode"],
    widget: BoardWidget,
    event: PointerEvent,
  ): void {
    if (!props.active || !props.canMutate || event.button !== 0 || gesture || mutationPending) {
      return;
    }
    const snapshot = props.snapshot;
    const tab = activeTab();
    if (!snapshot || !tab) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    try {
      if (event.currentTarget instanceof HTMLElement) {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }
    } catch {
      // Synthetic pointers and detached test targets cannot be captured.
    }
    const items = boardWidgetGridItems(orderedWidgets(snapshot, tab.tabId), contentHeights);
    gesture = {
      mode,
      name: widget.name,
      originClientX: event.clientX,
      originClientY: event.clientY,
      originW: widget.sizeW,
      originH: effectiveBoardWidgetRows(
        widget,
        contentHeights.get(widget.name),
        boardChromeRowPx(),
      ),
      pointerId: event.pointerId,
      items,
    };
    update((local) => {
      local.previewItems = items;
      local.gesture = { name: widget.name, mode };
    });
    gestureListeners = [
      listen(window, "pointermove", handlePointerMove),
      listen(window, "pointerup", handlePointerUp),
      listen(window, "pointercancel", handlePointerCancel),
    ];
  }

  function pointerPreview(
    event: PointerEvent,
    active: BoardPointerGesture,
    items: readonly BoardGridItem[],
  ) {
    const pointer =
      active.mode === "move" ? document.elementFromPoint(event.clientX, event.clientY) : null;
    const tabTarget = pointer?.closest<HTMLElement>("[data-board-tab-id]");
    if (
      active.mode === "move" &&
      (tabTarget || !grid || pointer?.closest(".board-grid") !== grid)
    ) {
      const tabId =
        tabTarget?.closest("openclaw-board-view") === host ? tabTarget.dataset.boardTabId : "";
      const hoverTabId =
        tabId && tabId !== activeTab()?.tabId && tabs().some((tab) => tab.tabId === tabId)
          ? tabId
          : "";
      return tabTarget && hoverTabId ? { hoverTabId, items: active.items } : undefined;
    }
    const bounds = grid?.getBoundingClientRect();
    const columnWidth = bounds
      ? Math.max(1, (bounds.width - BOARD_GRID_GAP * (BOARD_GRID_COLUMNS - 1)) / BOARD_GRID_COLUMNS)
      : BOARD_GRID_ROW_HEIGHT;
    if (active.mode === "resize") {
      return {
        hoverTabId: "",
        items: resize(
          active.items,
          active.name,
          active.originW +
            Math.round((event.clientX - active.originClientX) / (columnWidth + BOARD_GRID_GAP)),
          active.originH +
            Math.round(
              (event.clientY - active.originClientY) / (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP),
            ),
        ),
      };
    }
    if (!bounds) {
      return undefined;
    }
    // Reorder against the current preview so a moved card cannot undo its drop.
    const targetName = pointer?.closest<HTMLElementTagNameMap["openclaw-board-widget-cell"]>(
      "openclaw-board-widget-cell",
    )?.widget?.name;
    return {
      hoverTabId: "",
      items: previewDrag(items, active.name, {
        name: targetName,
        x: Math.floor((event.clientX - bounds.left) / (columnWidth + BOARD_GRID_GAP)),
        y: Math.floor((event.clientY - bounds.top) / (BOARD_GRID_ROW_HEIGHT + BOARD_GRID_GAP)),
      }),
    };
  }

  const handlePointerMove = (event: PointerEvent): void => {
    if (gesture && event.pointerId === gesture.pointerId) {
      const active = gesture;
      update((local) => {
        const next = pointerPreview(event, active, local.previewItems) ?? {
          items: active.items,
          hoverTabId: "",
        };
        local.previewItems = next.items;
        local.hoverTabId = next.hoverTabId;
      });
    }
  };

  const handlePointerUp = (event: PointerEvent): void => {
    const active = gesture;
    if (!active || event.pointerId !== active.pointerId) {
      return;
    }
    update((local) => {
      const result = pointerPreview(event, active, local.previewItems);
      clearGesture(local);
      const widget = props.snapshot?.widgets.find((entry) => entry.name === active.name);
      if (!widget || !result) {
        return;
      }
      if (active.mode === "move") {
        const position = result.hoverTabId
          ? nextPosition(result.hoverTabId)
          : (result.items.find((item) => item.name === active.name)?.order ?? widget.position);
        if (!result.hoverTabId && position === widget.position) {
          return;
        }
        void moveWidget(widget, position, result.hoverTabId || undefined).catch(() => undefined);
        return;
      }
      const resized = result.items.find((item) => item.name === active.name);
      if (resized && (resized.w !== active.originW || resized.h !== active.originH)) {
        void cellCallbacks.resizeTo(widget, resized.w, resized.h).catch(() => undefined);
      }
    });
  };

  const handlePointerCancel = (event: PointerEvent): void => {
    if (gesture && event.pointerId === gesture.pointerId) {
      update(clearGesture);
    }
  };

  function stopGesture(): void {
    gestureListeners.forEach((stop) => stop());
    gestureListeners = [];
    gesture = null;
  }

  function clearGesture(local: Presentation): void {
    stopGesture();
    local.gesture = { name: "", mode: "" };
    local.hoverTabId = "";
  }

  const selectTab = (tabId: string): void => {
    if (tabId !== activeTab()?.tabId && tabs().some((tab) => tab.tabId === tabId)) {
      props.callbacks?.selectTab(tabId);
    }
  };
  return {
    presentation,
    mutationFailure: createMemo(
      () => presentation.mutationFailure?.result.then(() => null) ?? null,
    ),
    visitedTabs,
    contentHeights,
    cellCallbacks,
    tabs,
    activeTab,
    reconcileInitialPresentation,
    selectPageWidgetMenuItem,
    teardown,
    selectTab,
    gridRef: (element: HTMLElement) => {
      grid = element;
    },
  };
}
