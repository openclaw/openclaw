/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { PanelTabStrip, type SolidPanelTabStripTab } from "./panel-tab-strip-solid.tsx";

const first: SolidPanelTabStripTab = {
  id: "first",
  domId: "tab-first",
  label: "First",
  closeLabel: "Close first",
};
const second: SolidPanelTabStripTab = {
  id: "second",
  domId: "tab-second",
  label: "Second",
  closeLabel: "Close second",
};
type Group = HTMLElement & {
  updateComplete: Promise<unknown>;
  getUpdateComplete(): Promise<unknown>;
};

function mountStrip(
  initial = [first, second],
  callbacks: {
    onSelect?: (id: string) => void;
    onClose?: (id: string) => void | Promise<void>;
    onReorder?: (source: string, target: string, placement: "before" | "after") => void;
  } = {},
) {
  const [tabs, setTabs] = createSignal(initial);
  const [activeId, setActiveId] = createSignal<string | null>(initial[0]?.id ?? null);
  const view = mountSolid(() => (
    <PanelTabStrip
      tabs={tabs()}
      activeId={activeId()}
      ariaControls="panel"
      onSelect={callbacks.onSelect ?? vi.fn()}
      onClose={callbacks.onClose ?? vi.fn()}
      onReorder={callbacks.onReorder}
      onNew={vi.fn()}
      newLabel="New tab"
    />
  ));
  const group = () => view.container.querySelector<Group>("wa-tab-group");
  return { ...view, group, setTabs, setActiveId };
}

afterEach(() => {
  Reflect.deleteProperty(customElements.get("wa-tab-group")?.prototype ?? {}, "updateComplete");
  document.documentElement.removeAttribute("dir");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps keyed tab nodes while publishing controlled selection and new labels", async () => {
  const onSelect = vi.fn();
  const view = mountStrip(undefined, { onSelect });
  const firstNode = view.container.querySelector("#tab-first");
  const secondNode = view.container.querySelector("#tab-second");
  await view.group()!.updateComplete;
  view.group()!.dispatchEvent(new CustomEvent("wa-tab-show", { detail: { name: "first" } }));
  expect(onSelect).not.toHaveBeenCalled();
  view.group()!.dispatchEvent(new CustomEvent("wa-tab-show", { detail: { name: "second" } }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("second");

  view.setTabs([{ ...second, label: "Renamed second" }, first]);
  view.setActiveId("second");
  flush();
  await view.group()!.updateComplete;
  expect([...view.container.querySelectorAll("wa-tab")]).toEqual([secondNode, firstNode]);
  expect(secondNode?.textContent).toContain("Renamed second");
  expect(secondNode?.getAttribute("aria-selected")).toBe("true");
  expect(view.container.querySelector<HTMLButtonElement>("#tab-second-close")?.tabIndex).toBe(0);
  expect(view.container.querySelector<HTMLButtonElement>("#tab-first-close")?.tabIndex).toBe(-1);
});

it("tracks empty and populated tab lists without creating an empty group", () => {
  const view = mountStrip([]);
  expect(view.group()).toBeNull();
  expect(view.container.querySelector(".tabstrip-new")?.hasAttribute("slot")).toBe(false);
  view.setTabs([first]);
  view.setActiveId(first.id);
  flush();
  expect(view.group()).not.toBeNull();
  expect(view.container.querySelector(".tabstrip-new")?.getAttribute("slot")).toBe("nav");
  view.setTabs([]);
  flush();
  expect(view.group()).toBeNull();
});

it("keeps activation, keyboard repeat, and middle-click close separate", () => {
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const view = mountStrip([{ ...first, onActivate }], { onClose });
  const tab = view.container.querySelector<HTMLElement>("wa-tab")!;
  tab.click();
  tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }));
  tab.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
  expect(onActivate).toHaveBeenCalledTimes(2);
  expect(onClose).toHaveBeenCalledExactlyOnceWith(first.id);
});

it.each(["ltr", "rtl"])("uses the same %s edge for drag preview and reorder", (direction) => {
  document.documentElement.dir = direction;
  const onReorder = vi.fn();
  const view = mountStrip(undefined, { onReorder });
  const tabs = [...view.container.querySelectorAll<HTMLElement>("wa-tab")];
  const source = tabs[0]!;
  const target = tabs[1]!;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ left: 100, width: 80 } as DOMRect);
  // jsdom does not resolve inherited direction through custom elements.
  target.style.direction = direction;
  const dataTransfer = createDataTransferStub();
  for (const [element, type] of [
    [source, "dragstart"],
    [target, "dragover"],
  ] as const) {
    const event = new MouseEvent(type, { clientX: 110, bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    element.dispatchEvent(event);
  }
  const placement = direction === "rtl" ? "after" : "before";
  expect(target.classList.contains(`is-drop-${placement}`)).toBe(true);
  const drop = new MouseEvent("drop", { clientX: 110, bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
  target.dispatchEvent(drop);
  expect(onReorder).toHaveBeenCalledExactlyOnceWith("first", "second", placement);
  expect(view.group()?.hasAttribute("data-dragged-panel-tab")).toBe(false);
});

it("does not install late measurement observers after disposal", async () => {
  const gate = createDeferred<boolean>();
  Object.defineProperty(customElements.get("wa-tab-group")!.prototype, "updateComplete", {
    configurable: true,
    get: () => gate.promise,
  });
  const observer = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor() {
        observer();
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const view = mountStrip();
  // Let Web Awesome create its shadow scroller while holding the public layout
  // promise that the Solid measurement owner awaits.
  await view.group()!.getUpdateComplete();
  const initialObservers = observer.mock.calls.length;
  view.unmount();
  gate.resolve(true);
  await gate.promise;
  expect(observer).toHaveBeenCalledTimes(initialObservers);
});
