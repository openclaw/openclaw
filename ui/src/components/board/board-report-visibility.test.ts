import { afterEach, expect, it, vi } from "vitest";
import { createBoardWidget } from "../../lib/board/widget.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { gatewayContext, mount, settleCells, snapshot } from "./board-view.test-support.ts";
import { cleanupCells } from "./board-widget-cell.test-support.ts";
import "./board-view.tsx";

afterEach(() => {
  cleanupCells();
  vi.unstubAllGlobals();
});

it("windows fixed reports while retaining focus, updates, geometry and admitted identities", async () => {
  const observers: ((target: Element) => void)[] = [];
  const unobserve = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observers.push((target) => {
          const entry = {
            target,
            contentRect: new DOMRectReadOnly(),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          };
          callback([entry], this);
        });
      }
      observe() {}
      unobserve = unobserve;
      disconnect() {}
    },
  );
  const widgets = Array.from({ length: 6 }, (_, index) =>
    createBoardWidget({
      name: `report-${index}`,
      tabId: index === 4 ? "ops" : "main",
      position: index,
      sizeW: 12,
      contentKind: "plugin",
      pluginKind: "session:report",
      heightMode: "fixed",
      props: { blocks: [{ type: "text", text: `Report ${index}` }] },
    }),
  );
  const context = gatewayContext(null);
  context.gateway.snapshot.hello = {
    ...gatewayHelloForMethods([]),
    controlUiWidgetKinds: [{ pluginId: "session", kind: "session:report", label: "Report" }],
  };
  const initial = snapshot({ widgets });
  const view = await mount({ snapshot: initial, context });
  view.snapshot = undefined;
  await settleCells(view);
  view.snapshot = initial;
  await settleCells(view);
  const grid = view.querySelector<HTMLElement>(".board-grid")!;
  const card = (index: number) =>
    view.querySelector<HTMLElement>(`[data-widget-name="report-${index}"]`);
  const first = card(0)!;
  expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(1);
  expect(card(2)).toBeNull();
  expect(grid.querySelector<HTMLElement>(".board-grid__extent")!.style.gridRow).toBe("20 / span 1");
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await waitForSolid(() => expect(document.activeElement).toBe(card(1)));
  expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(2);
  Object.defineProperty(view, "clientHeight", { value: 100 });
  vi.spyOn(grid, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(0, -view.scrollTop, 800, 1348),
  );
  view.scrollTop = 816;
  for (const callback of observers) {
    callback(grid);
  }
  await settleCells(view);
  expect(card(2)!.style.gridRow).toBe("9 / span 4");
  const cell = card(2)!.parentElement!;
  await waitForSolid(() => expect(cell.textContent).toContain("Report 2"));
  expect(cell.querySelector(".board-widget__menu-trigger")).not.toBeNull();
  const report = cell.querySelector("openclaw-report-widget");
  view.activeTabId = "ops";
  view.snapshot = snapshot({
    revision: 2,
    widgets: widgets.toSpliced(2, 1, {
      ...widgets[2],
      revision: 2,
      props: { blocks: [{ type: "text", text: "Updated while hidden" }] },
    }),
  });
  await waitForSolid(() => expect(report?.textContent).toContain("Updated while hidden"));
  view.activeTabId = "main";
  view.scrollTop = 0;
  view.dispatchEvent(new Event("scroll"));
  await settleCells(view);
  expect(card(2)!.parentElement).toBe(cell);
  expect(cell.querySelector("openclaw-report-widget")).toBe(report);
  expect(card(0)).toBe(first);
  // An unseen report changing to auto height must mount even outside the viewport.
  view.snapshot = snapshot({
    revision: 3,
    widgets: widgets.toSpliced(5, 1, { ...widgets[5], heightMode: "auto" }),
  });
  await waitForSolid(() => expect(card(5)).not.toBeNull());
  cleanupCells();
  await waitForSolid(() => expect(unobserve).toHaveBeenCalledWith(grid));
});
