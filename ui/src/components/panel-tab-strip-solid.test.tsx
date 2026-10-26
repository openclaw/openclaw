/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { PanelTabStrip, type SolidPanelTabStripTab } from "./panel-tab-strip-solid.tsx";

const first = { id: "a", domId: "a", label: "A", closeLabel: "Close A" };
const second = { id: "b", domId: "b", label: "B", closeLabel: "Close B" };
function mountStrip(
  initial: SolidPanelTabStripTab[] = [first, second],
  onReorder?: Parameters<typeof PanelTabStrip>[0]["onReorder"],
) {
  const callbacks = { onSelect: vi.fn(), onClose: vi.fn(), onNew: vi.fn() };
  const [props, setProps] = createSignal({
    tabs: initial,
    activeId: initial[0]?.id ?? null,
    ariaControls: "panel",
    ...callbacks,
    onReorder,
    newLabel: "New tab",
  });
  const view = mountSolid(() => <PanelTabStrip {...props()} />);
  const query = (selector: string) => view.container.querySelector<HTMLElement>(selector);
  const button = (id: string) => view.container.querySelector<HTMLButtonElement>(`#${id}`)!;
  const update = (next: SolidPanelTabStripTab[], active = props().activeId) => {
    setProps((current) => ({ ...current, tabs: next, activeId: active }));
    flush();
  };
  return { ...view, ...callbacks, button, query, update };
}
afterEach(() => {
  document.documentElement.removeAttribute("dir");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("preserves keyed nodes, controlled selection, and updated labels", () => {
  const { button, update, onSelect, container } = mountStrip();
  const [firstNode, secondNode] = [button("a"), button("b")] as const;
  firstNode.click();
  expect(onSelect).not.toHaveBeenCalled();
  secondNode.click();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith("b");
  update([{ ...second, label: "Renamed second" }, first], "b");
  expect([...container.querySelectorAll('[role="tab"]')]).toEqual([secondNode, firstNode]);
  expect(secondNode).toMatchObject({ textContent: expect.stringContaining("Renamed second") });
  expect(secondNode.getAttribute("aria-selected")).toBe("true");
  expect([button("b-close").tabIndex, button("a-close").tabIndex]).toEqual([0, -1]);
  secondNode.click();
  expect(onSelect).toHaveBeenCalledOnce();
});

it("creates the group only for populated lists and slots the new-tab action", () => {
  const { query, update, onNew } = mountStrip([]);
  expect(query(".tabstrip")).toBeNull();
  expect(query(".tabstrip-new")?.hasAttribute("slot")).toBe(false);
  query(".tabstrip-new")!.click();
  expect(onNew).toHaveBeenCalledOnce();
  update([first], first.id);
  expect(query(".tabstrip")).not.toBeNull();
  expect(query(".tabstrip-new")?.getAttribute("slot")).toBe("nav");
  update([]);
  expect(query(".tabstrip")).toBeNull();
});

it("separates activation, keyboard repeat, and middle-click close", () => {
  const onActivate = vi.fn();
  const { button, onClose, onSelect } = mountStrip([first, { ...second, onActivate }]);
  const tab = button("b");
  tab.click();
  for (const key of ["Enter", " "]) {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    tab.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    tab.dispatchEvent(new KeyboardEvent("keydown", { key, repeat: true, bubbles: true }));
  }
  tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  tab.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
  expect(onActivate).toHaveBeenCalledTimes(3);
  expect(onClose).toHaveBeenCalledExactlyOnceWith(second.id);
  expect(onSelect).not.toHaveBeenCalled();
});

it("disables both close gestures without disabling selection", () => {
  const tabs = [first, { ...second, closeDisabled: true }];
  const { button, update, onClose, onSelect } = mountStrip(tabs);
  const [tab, close] = [button("b"), button("b-close")] as const;
  expect(close.disabled).toBe(true);
  close.click();
  tab.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
  tab.click();
  expect(onClose).not.toHaveBeenCalled();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(second.id);
  update([first, second]);
  expect(close.disabled).toBe(false);
  close.click();
  expect(onClose).toHaveBeenCalledExactlyOnceWith(second.id);
});

it.each(["ltr", "rtl"])("uses the same %s edge for drag preview and reorder", (direction) => {
  document.documentElement.dir = direction;
  const onReorder = vi.fn();
  const { button, query } = mountStrip(undefined, onReorder);
  const [source, target] = [button("a"), button("b")] as const;
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 0, 80, 0));
  // jsdom does not resolve inherited direction through custom elements.
  target.style.direction = direction;
  const dataTransfer = createDataTransferStub();
  const drag = (element: HTMLElement, type: string) => {
    const event = new MouseEvent(type, { clientX: 110, bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    element.dispatchEvent(event);
  };
  drag(source, "dragstart");
  drag(target, "dragover");
  flush();
  const placement = direction === "rtl" ? "after" : "before";
  expect(target.classList.contains(`is-drop-${placement}`)).toBe(true);
  drag(target, "drop");
  expect(onReorder).toHaveBeenCalledExactlyOnceWith("a", "b", placement);
  expect(query(".tabstrip")?.hasAttribute("data-dragged-panel-tab")).toBe(false);
  flush();
  expect(target.classList.contains(`is-drop-${placement}`)).toBe(false);
});

it("releases measurement observers on disposal", () => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  const observed = new Set<Element>();
  const disconnected = vi.fn(() => observed.clear());
  const observer = vi.fn(function () {
    return {
      observe: (target: Element) => observed.add(target),
      unobserve: (target: Element) => observed.delete(target),
      disconnect: disconnected,
    };
  });
  vi.stubGlobal("ResizeObserver", observer);
  const view = mountStrip();
  flush();
  vi.advanceTimersToNextFrame();
  const initialObservers = observer.mock.calls.length;
  expect(initialObservers).toBeGreaterThan(0);
  const firstTargets = new Set(observed);
  const other = mountStrip();
  flush();
  vi.advanceTimersToNextFrame();
  const otherTargets = new Set([...observed].filter((target) => !firstTargets.has(target)));
  expect(otherTargets.size).toBeGreaterThan(0);
  view.unmount();
  expect(observed).toEqual(otherTargets);
  expect(disconnected).not.toHaveBeenCalled();

  const label = other.query(".tabstrip-tab__label")!;
  Object.defineProperties(label, {
    scrollWidth: { configurable: true, value: 100 },
    clientWidth: { configurable: true, value: 20 },
  });
  other.query(".tabstrip")!.dispatchEvent(new Event("scroll"));
  vi.advanceTimersToNextFrame();
  expect(label.classList.contains("is-overflowing")).toBe(true);

  other.query(".tabstrip")!.dispatchEvent(new Event("scroll"));
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  other.unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(observed.size).toBe(0);
  expect(observer).toHaveBeenCalledTimes(initialObservers);
  expect(disconnected).toHaveBeenCalledTimes(initialObservers);
  vi.advanceTimersToNextFrame();
  expect(observed.size).toBe(0);
  expect(observer).toHaveBeenCalledTimes(initialObservers);
});
