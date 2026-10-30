import { afterEach, expect, it, vi } from "vitest";
import { createBoardWidget } from "../../lib/board/widget.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { gatewayContext, mount, settleCells, snapshot } from "./board-view.test-support.ts";
import { cleanupCells } from "./board-widget-cell.test-support.ts";
import "./board-widget-cell.solid.tsx";
import "./board-view.tsx";

afterEach(() => {
  cleanupCells();
  vi.unstubAllGlobals();
});

function mockIntersections() {
  const observers: { targets: Set<Element>; deliver: (target: Element) => void }[] = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      targets = new Set<Element>();
      constructor(callback: IntersectionObserverCallback) {
        observers.push({
          targets: this.targets,
          deliver: (target) => {
            // SAFETY: The observer fixture only needs target/isIntersecting.
            callback(
              [{ target, isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
          },
        });
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  return observers;
}

it("defers fixed reports until nearby, then retains their body and current content across tabs", async () => {
  const observers = mockIntersections();
  const widget = createBoardWidget({
    contentKind: "plugin",
    pluginKind: "session:report",
    heightMode: "fixed",
    props: { blocks: [{ type: "text", text: "Initial report" }] },
  });
  const context = gatewayContext(null);
  context.gateway.snapshot.hello = {
    ...gatewayHelloForMethods([]),
    controlUiWidgetKinds: [{ pluginId: "session", kind: "session:report", label: "Report" }],
  };
  const initial = snapshot({
    widgets: [
      { ...widget, name: "first", position: 0 },
      { ...widget, position: 1 },
      { ...widget, name: "ops-report", tabId: "ops" },
    ],
  });
  const view = await mount({ snapshot: initial, context });
  await vi.dynamicImportSettled();
  const target = view.querySelector(`[data-widget-name="${widget.name}"]`)!;
  expect(target.getAttribute("style")).toContain("grid-row: 1 / span 4");
  expect(target.classList.contains("board-widget--deferred")).toBe(true);
  const observer = observers.find(({ targets }) => targets.has(target));
  observer!.deliver(target);
  await settleCells(view);
  await vi.dynamicImportSettled();
  const cell = view.querySelector(`[data-widget-name="${widget.name}"]`)!.parentElement!;
  await waitForSolid(() => expect(cell.textContent).toContain("Initial report"));
  expect(cell.querySelector(".board-widget__menu-trigger")).not.toBeNull();
  const report = cell.querySelector("openclaw-report-widget");
  expect(observer!.targets.has(target)).toBe(false);
  view.activeTabId = "ops";
  view.snapshot = {
    ...initial,
    revision: 2,
    widgets: initial.widgets.map((current) =>
      current.name === widget.name
        ? Object.assign({}, current, {
            revision: 2,
            props: { blocks: [{ type: "text", text: "Updated while hidden" }] },
          })
        : current,
    ),
  };
  await waitForSolid(() => expect(report?.textContent).toContain("Updated while hidden"));
  view.activeTabId = "main";
  await settleCells(view);
  expect(cell.querySelector("openclaw-report-widget")).toBe(report);
  cleanupCells();
  await waitForSolid(() => expect(observers.every(({ targets }) => targets.size === 0)).toBe(true));
});

it("admits offscreen fixed cards for visibility or keyboard focus and retains admitted identities", async () => {
  const observers = mockIntersections();
  const widgets = Array.from({ length: 20 }, (_, index) =>
    createBoardWidget({
      name: `report-${index}`,
      tabId: index === 19 ? "ops" : "main",
      position: index,
      contentKind: "plugin",
      pluginKind: "session:report",
      heightMode: "fixed",
    }),
  );
  const view = await mount({ snapshot: snapshot({ widgets }) });
  expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(1);
  const first = view.querySelector("openclaw-board-widget-cell")!;
  const placeholder = view.querySelector<HTMLElement>('[data-widget-name="report-18"]')!;
  expect(placeholder.style.gridRow).toBeTruthy();
  observers.find(({ targets }) => targets.has(placeholder))!.deliver(placeholder);
  await settleCells(view);
  expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(2);
  const admitted = view.querySelector('[data-widget-name="report-18"]')!.parentElement;

  first
    .querySelector(".board-widget")!
    .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await waitForSolid(() =>
    expect(document.activeElement?.getAttribute("data-widget-name")).toBe("report-1"),
  );
  expect(view.querySelectorAll("openclaw-board-widget-cell")).toHaveLength(3);
  view.activeTabId = "ops";
  await settleCells(view);
  view.activeTabId = "main";
  await settleCells(view);
  expect(view.querySelector('[data-widget-name="report-18"]')!.parentElement).toBe(admitted);
  expect(view.querySelector("openclaw-board-widget-cell")).toBe(first);

  view.snapshot = snapshot({
    revision: 2,
    widgets: widgets.map((widget) =>
      widget.name === "report-17"
        ? Object.assign({}, widget, { heightMode: "auto" as const, revision: 2 })
        : widget,
    ),
  });
  await waitForSolid(() =>
    expect(view.querySelector('[data-widget-name="report-17"]')!.parentElement?.localName).toBe(
      "openclaw-board-widget-cell",
    ),
  );
});
