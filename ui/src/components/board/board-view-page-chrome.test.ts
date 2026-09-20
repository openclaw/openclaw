import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import "./board-view.ts";
import { boardWidget, callbacks, mount, settleCells, snapshot } from "./board-view.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("page-owned board widget chrome", () => {
  it("relocates page chrome without replacing the live widget document", async () => {
    const view = await mount({
      snapshot: snapshot({ widgets: [boardWidget({ sizeW: 12, grantState: "granted" })] }),
    });
    const frame = view.querySelector("iframe");
    const chrome = ".board-widget__bar, .board-widget__resize-handle, .board-widget__grant-dot";
    expect(view.querySelectorAll(chrome)).toHaveLength(3);
    view.pageWidgetName = "alpha";
    await settleCells(view);
    expect(view.querySelectorAll(chrome)).toHaveLength(0);
    expect(view.querySelector("iframe")).toBe(frame);
    expect(view.querySelector(".board-widget")?.getAttribute("aria-label")).toBe("Alpha status");
    view.pageWidgetName = "";
    await settleCells(view);
    expect(view.querySelectorAll(chrome)).toHaveLength(3);
    expect(view.querySelector("iframe")).toBe(frame);
  });

  it("keeps page actions with their current cell, including serialization and visible failures", async () => {
    const pending = deferred();
    const applyOps = vi.fn(() => pending.promise);
    const view = await mount({
      snapshot: snapshot({ widgets: [boardWidget({ sizeW: 12 })] }),
      callbacks: callbacks({ applyOps }),
    });
    view.pageWidgetName = "alpha";
    await settleCells(view);
    const frame = view.querySelector("iframe");
    view.selectPageWidgetMenuItem("alpha", 2, "remove");
    expect(applyOps).not.toHaveBeenCalled();
    view.selectPageWidgetMenuItem("alpha", 1, "resize:md");
    expect(applyOps).toHaveBeenCalledWith([
      { kind: "widget_resize", name: "alpha", sizeW: 6, sizeH: 4, heightMode: "fixed" },
    ]);
    view.selectPageWidgetMenuItem("alpha", 1, "remove");
    expect(applyOps).toHaveBeenCalledTimes(1);
    pending.reject(new Error("page resize failed"));
    await vi.waitFor(() =>
      expect(view.querySelector("[data-test-id=board-widget-action-error]")?.textContent).toContain(
        "page resize failed",
      ),
    );
    expect(view.querySelector("iframe")).toBe(frame);
    view.canMutate = false;
    view.selectPageWidgetMenuItem("alpha", 1, "remove");
    view.canMutate = true;
    view.activeTabId = "ops";
    view.selectPageWidgetMenuItem("alpha", 1, "remove");
    expect(applyOps).toHaveBeenCalledTimes(1);
  });
});
