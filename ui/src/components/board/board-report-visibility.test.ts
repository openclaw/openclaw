import { afterEach, expect, it, vi } from "vitest";
import { createBoardWidget } from "../../lib/board/widget.test-support.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { gatewayContext } from "./board-view.test-support.ts";
import { cleanupCells, mountCell } from "./board-widget-cell.test-support.ts";
import "./board-widget-cell.solid.tsx";

afterEach(() => {
  cleanupCells();
  vi.unstubAllGlobals();
});

it("defers fixed reports until nearby, then retains their body and current content across tabs", async () => {
  const observers: Array<{
    targets: Set<Element>;
    deliver: (target: Element) => void;
  }> = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      targets = new Set<Element>();
      constructor(callback: IntersectionObserverCallback) {
        observers.push({
          targets: this.targets,
          deliver: (target) => {
            // SAFETY: The visibility pool consumes only target/isIntersecting;
            // this fixture supplies the native observer's delivery contract.
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
  const widget = createBoardWidget({
    name: "deferred-report",
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
  const cell = mountCell(widget, { context });
  await cell.updateComplete;
  expect(cell.querySelector(".board-widget")?.getAttribute("style")).toContain(
    "grid-row: 1 / span 4",
  );
  expect(cell.querySelector("openclaw-report-widget")).toBeNull();
  expect(cell.querySelector(".board-widget__menu-trigger")).toBeNull();
  const target = cell.querySelector(".board-widget")!;
  const observer = observers.find(({ targets }) => targets.has(target));
  expect(observer).toBeDefined();
  observer!.deliver(target);
  await waitForSolid(() => expect(cell.textContent).toContain("Initial report"));
  expect(cell.querySelector(".board-widget__menu-trigger")).not.toBeNull();
  const report = cell.querySelector("openclaw-report-widget");
  expect(observer!.targets.has(target)).toBe(false);

  cell.active = false;
  cell.hidden = true;
  cell.widget = {
    ...widget,
    revision: 2,
    props: { blocks: [{ type: "text", text: "Updated while hidden" }] },
  };
  await waitForSolid(() => expect(report?.textContent).toContain("Updated while hidden"));
  cell.active = true;
  cell.hidden = false;
  await cell.updateComplete;
  expect(cell.querySelector("openclaw-report-widget")).toBe(report);

  const auto = mountCell({ ...widget, name: "auto-report", heightMode: "auto" }, { context });
  await waitForSolid(() => expect(auto.textContent).toContain("Initial report"));
  expect(observers.some(({ targets }) => targets.has(auto.querySelector(".board-widget")!))).toBe(
    false,
  );
  cleanupCells();
  expect(observers.every(({ targets }) => targets.size === 0)).toBe(true);
});
