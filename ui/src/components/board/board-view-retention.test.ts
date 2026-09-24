import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardOp } from "../../lib/board/types.ts";
import { applyBoardFixtureOps } from "../../test-helpers/board-fixture.ts";
import "./board-view.ts";
import { callbacks, mount, settleCells, snapshot } from "./board-view.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("openclaw-board-view retention", () => {
  it("preserves each widget cell and iframe identity when order changes", async () => {
    const view = await mount();
    const before = [...view.querySelectorAll("openclaw-board-widget-cell")].find(
      (cell) => cell.widget?.name === "alpha",
    );
    const frame = before?.querySelector("iframe");
    const removedNodes: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        removedNodes.push(...record.removedNodes);
      }
    });
    observer.observe(view.querySelector(".board-grid")!, { childList: true });
    const reordered = snapshot();
    reordered.widgets = reordered.widgets.map((widget) =>
      widget.name === "alpha"
        ? { ...widget, position: 1 }
        : widget.name === "beta"
          ? { ...widget, position: 0 }
          : widget,
    );
    view.snapshot = reordered;
    const cells = await settleCells(view);
    const after = cells.find((cell) => cell.widget?.name === "alpha");
    expect(after).toBe(before);
    expect(after?.querySelector("iframe")).toBe(frame);
    expect(removedNodes).not.toContain(before);
    expect(after?.querySelector(".board-widget")?.getAttribute("aria-posinset")).toBe("2");
    expect(
      cells
        .find((cell) => cell.widget?.name === "beta")
        ?.querySelector(".board-widget")
        ?.getAttribute("aria-posinset"),
    ).toBe("1");
    observer.disconnect();

    view.snapshot = { ...snapshot(), sessionKey: "agent:main:other-session" };
    const sessionCells = await settleCells(view);
    const afterSessionChange = sessionCells.find((cell) => cell.widget?.name === "alpha");
    expect(afterSessionChange).not.toBe(before);
    expect(afterSessionChange?.querySelector("iframe")).not.toBe(frame);
  });

  it("routes tab selection and updates cells when the host changes the active prop", async () => {
    const selectTab = vi.fn();
    const view = await mount({ callbacks: callbacks({ selectTab }) });
    expect(selectTab).not.toHaveBeenCalled();
    view.querySelector(".board-tabs__track")?.dispatchEvent(
      new CustomEvent("wa-tab-show", {
        detail: { name: "ops" },
        bubbles: true,
      }),
    );
    expect(selectTab).toHaveBeenCalledWith("ops");

    view.activeTabId = "ops";
    const cells = await settleCells(view);
    const visible = cells.filter((cell) => !cell.hidden);
    expect(visible.map((cell) => cell.widget?.name)).toEqual(["ops-only"]);
    for (const cell of cells.filter((candidate) => candidate.hidden)) {
      expect(cell.active).toBe(false);
      expect(cell.hasAttribute("inert")).toBe(true);
    }
  });

  it("refreshes retained widgets and releases removed tabs without mounting unvisited tabs", async () => {
    const view = await mount({ widgetFrameUrl: (name, revision) => `/${name}/${revision}` });
    const first = view.querySelector("openclaw-board-widget-cell")!;
    const frame = first.querySelector("iframe");
    expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(2);
    view.activeTabId = "ops";
    await settleCells(view);
    const updated = snapshot({ revision: 2 });
    updated.widgets[0]!.revision = 3;
    view.snapshot = updated;
    await settleCells(view);
    expect(first.querySelector("iframe")).toBe(frame);
    expect(frame?.getAttribute("src")).toBe("/alpha/3");
    view.snapshot = {
      ...view.snapshot,
      tabs: view.snapshot.tabs.filter((tab) => tab.tabId !== "main"),
    };
    const remaining = await settleCells(view);
    expect(first.isConnected).toBe(false);
    expect(remaining.map((cell) => cell.widget?.name)).toEqual(["ops-only"]);
  });

  it("retires cached documents when the exact agent owner changes", async () => {
    const view = await mount();
    view.session = { agentId: "first-agent", sessionKey: "shared-display-key" };
    const previous = await settleCells(view);
    view.activeTabId = "ops";
    await settleCells(view);
    view.session = { agentId: "second-agent", sessionKey: "shared-display-key" };
    const current = await settleCells(view);
    expect(previous.every((cell) => !cell.isConnected)).toBe(true);
    expect(current.map((cell) => cell.widget?.name)).toEqual(["ops-only"]);
  });

  it("keeps a replacement widget lazy after its mounted namesake is deleted", async () => {
    const view = await mount();
    const cell = view.querySelector("openclaw-board-widget-cell")!;
    const original = cell.widget!;
    view.snapshot = applyBoardFixtureOps(view.snapshot!, [
      { kind: "widget_remove", name: original.name },
    ]);
    await settleCells(view);
    expect(cell.isConnected).toBe(false);

    view.snapshot = {
      ...view.snapshot,
      widgets: [...view.snapshot.widgets, { ...original, tabId: "ops" }],
    };
    const cells = await settleCells(view);
    expect(cells.some((entry) => entry.widget?.name === original.name)).toBe(false);
    view.activeTabId = "ops";
    const replacement = (await settleCells(view)).find(
      (entry) => entry.widget?.name === original.name,
    );
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(cell);
  });

  it("moves widgets to another tab from the kebab menu", async () => {
    const view = await mount();
    const cell = view.querySelector("openclaw-board-widget-cell")!;
    const frame = cell.querySelector("iframe");
    const applyOps = vi.fn(async (ops: BoardOp[]) => {
      view.snapshot = applyBoardFixtureOps(view.snapshot!, ops);
    });
    view.callbacks = callbacks({ applyOps });
    const moveButton = [...view.querySelectorAll<HTMLElement>("wa-dropdown-item")].find(
      (button) => button.textContent?.trim() === "Operations",
    );
    view.querySelector(".board-widget__menu")?.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: moveButton },
        bubbles: true,
      }),
    );
    await vi.waitFor(() =>
      expect(applyOps).toHaveBeenCalledWith([
        { kind: "widget_move", name: "alpha", tabId: "ops", position: 1 },
      ]),
    );
    await settleCells(view);
    expect(cell.isConnected).toBe(true);
    expect(cell.hidden).toBe(true);
    expect(cell.active).toBe(false);
    expect(cell.querySelector("iframe")).toBe(frame);
    expect(
      [...view.querySelectorAll("openclaw-board-widget-cell")].some(
        (entry) => entry.widget?.name === "ops-only",
      ),
    ).toBe(false);

    view.activeTabId = "ops";
    await settleCells(view);
    expect(cell.active).toBe(true);
    expect(cell.querySelector("iframe")).toBe(frame);
  });
});
