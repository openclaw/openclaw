import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardViewWidget } from "../../lib/board/view-types.ts";
import type { BoardWidgetCellCallbacks } from "./board-widget-cell.ts";
import "./board-widget-cell.ts";

function callbacks(): BoardWidgetCellCallbacks {
  const noAction = vi.fn(async () => undefined);
  return {
    grant: noAction,
    movePointerDown: vi.fn(),
    resizePointerDown: vi.fn(),
    moveToTab: noAction,
    resizeTo: noAction,
    remove: noAction,
    nudge: noAction,
    focus: vi.fn(),
    focusChanged: vi.fn(),
    frameLoadFailed: noAction,
    widgetAppView: vi.fn(async () => ({ status: "stale" as const, error: "unused" })),
    refreshWidgetAppView: vi.fn(async () => ({ status: "stale" as const, error: "unused" })),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("plugin board widget cells", () => {
  it("renders a removable placeholder when the owning plugin is inactive", async () => {
    const widget: BoardViewWidget = {
      name: "work-item",
      tabId: "main",
      title: "Work item",
      contentKind: "plugin",
      pluginKind: "workboard:card",
      props: { cardId: "card-123" },
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: 1,
    };
    const cellCallbacks = callbacks();
    const cell = document.createElement("openclaw-board-widget-cell");
    cell.widget = widget;
    cell.rect = { name: widget.name, x: 0, y: 0, w: 6, h: 4 };
    cell.sessionKey = "agent:main:test";
    cell.callbacks = cellCallbacks;
    document.body.append(cell);
    await cell.updateComplete;

    const placeholder = cell.querySelector('[data-test-id="board-disabled-plugin"]');
    expect(placeholder?.textContent).toContain("Widget from disabled plugin workboard");
    const removeButton = placeholder?.querySelector("button");
    expect(removeButton).not.toBeNull();
    removeButton?.click();
    await vi.waitFor(() => expect(cellCallbacks.remove).toHaveBeenCalledWith(widget));
  });
});
