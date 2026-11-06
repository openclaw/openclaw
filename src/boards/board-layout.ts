import type {
  BoardOp,
  BoardSnapshot,
  BoardTab,
  BoardWidget,
} from "../../packages/gateway-protocol/src/index.js";

export const BOARD_SIZE_PRESETS = {
  sm: { sizeW: 3, sizeH: 3 },
  md: { sizeW: 6, sizeH: 4 },
  lg: { sizeW: 8, sizeH: 6 },
  xl: { sizeW: 12, sizeH: 8 },
  full: { sizeW: 12, sizeH: 8 },
} as const;

export type BoardSize = keyof typeof BOARD_SIZE_PRESETS;
export const BOARD_WIDGET_PROPS_MAX_BYTES = 8 * 1024;
type BoardLayout = Pick<BoardSnapshot, "tabs" | "widgets">;
type BoardValidationErrorCode = "conflict" | "invalid_operation" | "not_found";

export class BoardValidationError extends Error {
  readonly code: BoardValidationErrorCode;

  constructor(code: BoardValidationErrorCode, message: string) {
    super(message);
    this.name = "BoardValidationError";
    this.code = code;
  }
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function comparePosition(a: { position: number }, b: { position: number }): number {
  return a.position - b.position;
}

export function normalizeBoardLayout(layout: BoardLayout): BoardLayout {
  return normalizeOwnedBoardLayout(structuredClone(layout));
}

// Public operations take ownership once; successive operations only reorder that copy.
/* oxlint-disable unicorn/no-array-sort -- Owned layouts and fresh filtered arrays are safe to sort. */
export function normalizeOwnedBoardLayout(layout: BoardLayout): BoardLayout {
  const tabs = layout.tabs.sort(comparePosition);
  tabs.forEach((tab, position) => {
    tab.position = position;
  });
  const tabPosition = new Map(tabs.map((tab) => [tab.tabId, tab.position]));
  const widgets = layout.widgets.sort((a, b) => {
    const tabDelta =
      (tabPosition.get(a.tabId) ?? Number.MAX_SAFE_INTEGER) -
      (tabPosition.get(b.tabId) ?? Number.MAX_SAFE_INTEGER);
    return tabDelta || a.position - b.position;
  });
  const nextPosition = new Map<string, number>();
  for (const widget of widgets) {
    const position = nextPosition.get(widget.tabId) ?? 0;
    widget.position = position;
    nextPosition.set(widget.tabId, position + 1);
  }
  return { tabs, widgets };
}

function requireTab(layout: BoardLayout, tabId: string): BoardTab {
  const tab = layout.tabs.find((candidate) => candidate.tabId === tabId);
  if (!tab) {
    throw new BoardValidationError("not_found", `board tab not found: ${tabId}`);
  }
  return tab;
}

function requireWidget(layout: BoardLayout, name: string): BoardWidget {
  const widget = layout.widgets.find((candidate) => candidate.name === name);
  if (!widget) {
    throw new BoardValidationError("not_found", `board widget not found: ${name}`);
  }
  return widget;
}

function moveTab(layout: BoardLayout, tab: BoardTab, position: number): void {
  const ordered = layout.tabs.filter((candidate) => candidate !== tab).sort(comparePosition);
  ordered.splice(clampInteger(position, 0, ordered.length), 0, tab);
  ordered.forEach((candidate, index) => {
    candidate.position = index;
  });
  layout.tabs = ordered;
}

function moveWidget(
  layout: BoardLayout,
  widget: BoardWidget,
  targetTabId: string,
  position?: number,
  after?: string,
): void {
  requireTab(layout, targetTabId);
  if (position !== undefined && after !== undefined) {
    throw new BoardValidationError(
      "invalid_operation",
      "widget_move accepts either position or after, not both",
    );
  }
  const targetWidgets = layout.widgets
    .filter((candidate) => candidate.tabId === targetTabId && candidate !== widget)
    .sort(comparePosition);
  let targetPosition = targetWidgets.length;
  if (after !== undefined) {
    if (after === widget.name) {
      throw new BoardValidationError("invalid_operation", "widget cannot be placed after itself");
    }
    const anchorIndex = targetWidgets.findIndex((candidate) => candidate.name === after);
    if (anchorIndex < 0) {
      throw new BoardValidationError(
        "not_found",
        `board widget anchor not found on tab ${targetTabId}: ${after}`,
      );
    }
    targetPosition = anchorIndex + 1;
  } else if (position !== undefined) {
    targetPosition = clampInteger(position, 0, targetWidgets.length);
  }
  widget.tabId = targetTabId;
  targetWidgets.splice(targetPosition, 0, widget);
  targetWidgets.forEach((candidate, index) => {
    candidate.position = index;
  });
  const otherWidgets = layout.widgets.filter(
    (candidate) => candidate !== widget && candidate.tabId !== targetTabId,
  );
  layout.widgets = [...otherWidgets, ...targetWidgets];
}

function applyBoardOp(layout: BoardLayout, op: BoardOp): void {
  switch (op.kind) {
    case "tab_create": {
      if (layout.tabs.some((tab) => tab.tabId === op.tabId)) {
        throw new BoardValidationError("conflict", `board tab already exists: ${op.tabId}`);
      }
      layout.tabs.push({
        tabId: op.tabId,
        title: op.title,
        position: layout.tabs.length,
        chatDock: op.chatDock ?? "right",
      });
      return;
    }
    case "tab_update": {
      const tab = requireTab(layout, op.tabId);
      if (op.title === undefined && op.chatDock === undefined && op.position === undefined) {
        throw new BoardValidationError("invalid_operation", "tab_update has no changes");
      }
      if (op.title !== undefined) {
        tab.title = op.title;
      }
      if (op.chatDock !== undefined) {
        tab.chatDock = op.chatDock;
      }
      if (op.position !== undefined) {
        moveTab(layout, tab, op.position);
      }
      return;
    }
    case "tab_delete": {
      const tab = requireTab(layout, op.tabId);
      const remainingTabs = layout.tabs
        .filter((candidate) => candidate !== tab)
        .sort(comparePosition);
      const tabWidgets = layout.widgets
        .filter((widget) => widget.tabId === tab.tabId)
        .sort(comparePosition);
      if (remainingTabs.length === 0 && tabWidgets.length > 0) {
        throw new BoardValidationError(
          "invalid_operation",
          "cannot delete the last board tab while it contains widgets",
        );
      }
      layout.tabs = remainingTabs;
      if (tabWidgets.length > 0) {
        const fallback = remainingTabs[0]!;
        for (const widget of tabWidgets) {
          widget.tabId = fallback.tabId;
          widget.position = Number.MAX_SAFE_INTEGER;
        }
      }
      return;
    }
    case "tabs_reorder": {
      if (
        op.tabIds.length !== layout.tabs.length ||
        new Set(op.tabIds).size !== op.tabIds.length ||
        op.tabIds.some((tabId) => !layout.tabs.some((tab) => tab.tabId === tabId))
      ) {
        throw new BoardValidationError(
          "invalid_operation",
          "tabs_reorder must contain every tab exactly once",
        );
      }
      const byId = new Map(layout.tabs.map((tab) => [tab.tabId, tab]));
      layout.tabs = op.tabIds.map((tabId, position) => {
        const tab = byId.get(tabId)!;
        tab.position = position;
        return tab;
      });
      return;
    }
    case "widget_move": {
      const widget = requireWidget(layout, op.name);
      moveWidget(layout, widget, op.tabId ?? widget.tabId, op.position, op.after);
      return;
    }
    case "widget_resize": {
      const widget = requireWidget(layout, op.name);
      widget.sizeW = clampInteger(op.sizeW, 1, 12);
      widget.sizeH = clampInteger(op.sizeH, 1, 20);
      // A resize is always explicit user intent: legacy clients omit heightMode
      // and must still pin, or the next content report undoes their resize.
      widget.heightMode = op.heightMode ?? "fixed";
      return;
    }
    case "widget_remove": {
      requireWidget(layout, op.name);
      layout.widgets = layout.widgets.filter((widget) => widget.name !== op.name);
    }
  }
}

/* oxlint-enable unicorn/no-array-sort */

export function applyBoardOps(layout: BoardLayout, ops: readonly BoardOp[]): BoardLayout {
  const next = structuredClone(layout);
  for (const op of ops) {
    applyBoardOp(next, op);
    normalizeOwnedBoardLayout(next);
  }
  return ops.length > 0
    ? { tabs: next.tabs, widgets: next.widgets }
    : normalizeOwnedBoardLayout(next);
}

export function insertBoardWidget(
  layout: BoardLayout,
  widget: BoardWidget,
  placement: { tabId: string; after?: string; move?: boolean },
): BoardLayout {
  const next = structuredClone(layout);
  const index = next.widgets.findIndex((candidate) => candidate.name === widget.name);
  const existing = next.widgets[index];
  // The producer fully materializes the replacement widget. Preserve position
  // only because layout movement is explicit below; omitted optional metadata
  // must not survive from the previous revision.
  const inserted: BoardWidget = { ...structuredClone(widget), tabId: placement.tabId };
  if (existing) {
    inserted.position = existing.position;
    next.widgets[index] = inserted;
  } else {
    next.widgets.push(inserted);
  }
  if (!existing || placement.move) {
    moveWidget(next, inserted, placement.tabId, undefined, placement.after);
  }
  return normalizeOwnedBoardLayout(next);
}
