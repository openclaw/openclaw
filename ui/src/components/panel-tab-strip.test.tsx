/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createTabFocus } from "../lib/tabs.ts";
import { createFrameClock } from "../test-helpers/animation-frame-clock.ts";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import {
  PanelTabStrip,
  type SolidPanelTabStripTab as PanelTabStripTab,
  type PanelTabStripProps,
} from "./panel-tab-strip-solid.tsx";

const makeTab = (index = 1, overrides: Partial<PanelTabStripTab> = {}): PanelTabStripTab => ({
  id: `tab-${index}`,
  domId: `test-tab-${index}`,
  label: "First tab",
  closeLabel: "Close tab: First tab",
  ...overrides,
});
const TAB = makeTab();
const host = () => document.body.appendChild(document.createElement("div"));
type StripProps = PanelTabStripProps<PanelTabStripTab>;
type StripOptions = Partial<StripProps> & { container?: HTMLDivElement };
type MountedStrip = { update: (props: StripProps) => void; unmount: () => void };
const strips = new Map<HTMLDivElement, MountedStrip>();

async function renderStrip(options: StripOptions) {
  const container = options.container ?? host();
  const props: StripProps = {
    tabs: options.tabs ?? [],
    activeId: options.activeId ?? options.tabs?.[0]?.id ?? null,
    ariaControls: "test-tab-panel",
    onSelect: vi.fn(),
    onClose: vi.fn(),
    onNew: vi.fn(),
    newLabel: "New tab",
    ...options,
  };
  const mounted = strips.get(container);
  if (mounted) {
    mounted.update(props);
  } else {
    const [current, update] = createSignal(props);
    const view = mountSolid(() => <PanelTabStrip {...current()} />, { container });
    strips.set(container, { update, unmount: view.unmount });
  }
  flush();
  await Promise.resolve();
  return container;
}

function unmountStrip(container: HTMLDivElement) {
  strips.get(container)?.unmount();
  strips.delete(container);
}

function measureEdges(element: Element, edges: () => [number, number]) {
  return vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => {
    const [left, right] = edges();
    return new DOMRect(left, 0, right - left, 0);
  });
}

const tabStrip = (root: ParentNode, suffix = "") =>
  root.querySelector<HTMLElement>(`.tabstrip${suffix}`)!;
const renderedTabs = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>(".tabstrip-tab")];
function dispatchDrag(element: HTMLElement, type: string, dataTransfer: object, clientX = 0) {
  const event = new MouseEvent(type, { bubbles: true, clientX, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  element.dispatchEvent(event);
}

function overflowState(label: HTMLElement) {
  return [
    label.hasAttribute("data-tooltip-overflow"),
    label.parentElement?.classList.contains("has-label-overflow"),
  ];
}
function scrollEdges(group: HTMLElement) {
  return ["left", "right"].map((edge) => group.classList.contains(`has-scroll-${edge}`));
}
function widths(label: HTMLElement, clientWidth: number, scrollWidth: number | (() => number)) {
  Object.defineProperties(label, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: {
      configurable: true,
      ...(typeof scrollWidth === "function" ? { get: scrollWidth } : { value: scrollWidth }),
    },
  });
}

function recordMeasurement(
  label: HTMLElement,
  name: string | number,
  operations: string[],
  width = () => 200,
) {
  widths(label, 100, () => {
    operations.push(`read ${name}`);
    return width();
  });
  const toggle = label.classList.toggle.bind(label.classList);
  vi.spyOn(label.classList, "toggle").mockImplementation((token, force) => {
    operations.push(`write ${name}`);
    return toggle(token, force);
  });
}

function tabMeasurementClock() {
  const framesClock = createFrameClock();

  const observers = new Set<ControlledResizeObserver>();
  class ControlledResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.add(this);
    }
    observe = (target: Element) => this.targets.add(target);
    unobserve = (target: Element) => this.targets.delete(target);
    disconnect = () => this.targets.clear();
  }
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  vi.stubGlobal("requestAnimationFrame", framesClock.request);
  vi.stubGlobal("cancelAnimationFrame", framesClock.cancel);
  return {
    async settle(container: ParentNode, measure = true) {
      flush();
      expect(tabStrip(container)).not.toBeNull();
      await Promise.resolve();
      if (measure) {
        this.flush();
      }
    },
    flush() {
      framesClock.flush(0);
    },
    resize(target: Element) {
      for (const observer of observers) {
        if (observer.targets.has(target)) {
          // SAFETY: The pooled delivery router reads only target.
          observer.callback([{ target } as ResizeObserverEntry], observer);
        }
      }
    },
    observed(target: Element) {
      return [...observers].some((observer) => observer.targets.has(target));
    },
  };
}

afterEach(() => {
  cleanupSolid();
  strips.clear();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("dir");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps interactive native controls mounted across tab updates", async () => {
  const onAction = vi.fn();
  const control = document.createElement("button");
  control.textContent = "First action";
  control.addEventListener("click", () => onAction(control.textContent));
  const container = await renderStrip({ tabs: [TAB], newControl: control });
  expect(tabStrip(container, "-new-control").getAttribute("slot")).toBe("nav");
  const button = tabStrip(container, "-new-control button");
  button.click();
  expect(onAction).toHaveBeenLastCalledWith("First action");
  control.textContent = "Updated action";
  await renderStrip({ tabs: [{ ...TAB, label: "Updated tab" }], container, newControl: control });
  expect(tabStrip(container, "-new-control button")).toBe(button);
  expect(button.textContent).toBe("Updated action");
  button.click();
  expect(onAction).toHaveBeenLastCalledWith("Updated action");
  unmountStrip(container);
  expect(button.isConnected).toBe(false);
});

it("retains icon content when tab projections and callbacks change", async () => {
  const icon = document.createElement("span");
  icon.textContent = "First icon";
  const tabs = [makeTab(1, { icon }), makeTab(2)];
  const container = await renderStrip({ tabs });
  const iconElement = tabStrip(container, "-tab__icon span");
  const onSelect = vi.fn();
  const projections = tabs.map((tab) => Object.assign({}, tab));
  await renderStrip({ tabs: projections, activeId: "tab-2", onSelect, container });
  expect(tabStrip(container, "-tab__icon span")).toBe(iconElement);
  renderedTabs(container)
    .find((tab) => tab.dataset.tabValue === TAB.id)
    ?.click();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(TAB.id);
  icon.textContent = "Updated icon";
  flush();
  expect(tabStrip(container, "-tab__icon span")).toBe(iconElement);
  expect(iconElement?.textContent).toBe("Updated icon");
});

it.each([
  { groups: [undefined, undefined, undefined, undefined], before: [2, 3, 4] },
  { groups: ["files", "browser", "browser", "terminal"], before: [2, 4] },
  { groups: ["browser", "browser", "browser", "browser"], before: [] },
])("keeps separators only outside adjacent groups ($groups)", async ({ groups, before }) => {
  const tabs = groups.map((group, index) => makeTab(index + 1, { group }));
  const container = await renderStrip({ tabs, separateTabs: true });
  const separatorTargets = () =>
    [...container.querySelectorAll(".tabstrip-separator")].map(
      (separator) => separator.nextElementSibling?.id,
    );

  expect(separatorTargets()).toEqual(before.map((index) => `test-tab-${index}`));
  await renderStrip({ tabs, separateTabs: true, activeId: "tab-2", container });
  expect(separatorTargets()).toEqual(before.map((index) => `test-tab-${index}`));
});

it("keeps a fixed tab selectable without a close action", async () => {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const container = await renderStrip({
    tabs: [
      { ...TAB, closable: false },
      { ...TAB, id: "tab-2", domId: "test-tab-2", label: "Second tab" },
    ],
    activeId: "tab-2",
    onClose,
    onSelect,
  });
  const tab = renderedTabs(container)[0]!;
  expect(tab.getAttribute("aria-selected")).toBe("false");
  expect(container.querySelector(`#${TAB.domId}-close`)).toBeNull();
  expect(container.querySelector('[role="group"]')?.getAttribute("aria-owns")).not.toContain(
    `${TAB.domId}-close`,
  );
  tab.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
  expect(onClose).not.toHaveBeenCalled();
  tab.click();
  expect(onSelect).toHaveBeenCalledWith(TAB.id);

  await renderStrip({ tabs: [TAB], container, onClose });
  expect(container.querySelector(".tabstrip-tab__close")).not.toBeNull();
  tab.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
  expect(onClose).toHaveBeenCalledExactlyOnceWith(TAB.id);
});

it.each([false, true])(
  "preserves close focus across replacement (outside focus: %s)",
  async (outsideFocus) => {
    const focusOwner = createTabFocus();
    const close = createDeferred();
    const remaining = makeTab(2);
    const outside = document.body.appendChild(document.createElement("button"));
    let closing = Promise.resolve();
    let container = host();
    await renderStrip({
      container,
      tabs: [TAB, remaining],
      focusOwner,
      onClose: (id) => {
        expect(id).toBe(TAB.id);
        closing = close.promise.then(async () => {
          const previous = container;
          container = await renderStrip({ tabs: [remaining], focusOwner });
          // The replacement may mount before the old owner is retired.
          unmountStrip(previous);
          previous.remove();
          if (outsideFocus) {
            outside.focus();
          }
        });
        return closing;
      },
    });
    const closeButton = tabStrip(container, "-tab__close");
    expect(closeButton.hasAttribute("title")).toBe(false);
    expect(closeButton.getAttribute("aria-label")).toBe(TAB.closeLabel);
    closeButton.focus();
    closeButton.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    closeButton.click();
    close.resolve();
    await closing;
    await Promise.resolve();
    expect(document.activeElement).toBe(outsideFocus ? outside : renderedTabs(container)[0]);
  },
);

it("batches overflow reads after content commits and skips unchanged renders", async () => {
  const clock = tabMeasurementClock();
  const added = vi.spyOn(HTMLElement.prototype, "addEventListener");
  const removed = vi.spyOn(HTMLElement.prototype, "removeEventListener");
  const tabs = [TAB, makeTab(2)];
  const container = await renderStrip({ tabs });
  const group = tabStrip(container)!;
  const labels = [...group.querySelectorAll<HTMLElement>(".tabstrip-tab__label")];
  const operations: string[] = [];
  for (const [index, label] of labels.entries()) {
    recordMeasurement(label, index, operations, () =>
      label.textContent!.startsWith("Long") ? 200 : 80,
    );
  }
  await clock.settle(container);
  operations.length = 0;

  for (let index = 0; index < 4; index += 1) {
    await renderStrip({ tabs, container });
  }
  await clock.settle(container);
  expect(operations).toEqual([]);

  const longLabels = tabs.map((tab) => Object.assign({}, tab, { label: "Long label" }));
  await renderStrip({ tabs: longLabels, container });
  expect(operations).toEqual([]);
  await clock.settle(container);
  expect(operations).toEqual(["read 0", "read 1", "write 0", "write 1"]);
  expect(labels.map(overflowState)).toEqual([
    [true, true],
    [true, true],
  ]);

  const exited = longLabels.map((tab) => Object.assign({}, tab, { className: "is-exited" }));
  await renderStrip({ tabs: exited, container });
  clock.flush();
  expect(
    labels.map((label) => label.parentElement?.classList.contains("has-label-overflow")),
  ).toEqual([true, true]);

  Object.defineProperty(labels[0]!, "clientWidth", { configurable: true, value: 250 });
  clock.resize(labels[0]!);
  clock.resize(labels[0]!);
  operations.length = 0;
  clock.flush();
  expect(operations.filter((operation) => operation.startsWith("read"))).toEqual([
    "read 0",
    "read 1",
  ]);
  expect(labels[0]!.hasAttribute("data-tooltip-overflow")).toBe(false);
  const scrollListeners = (spy: typeof added) =>
    spy.mock.calls.filter(
      ([type], index) => type === "scroll" && spy.mock.contexts[index] === group,
    ).length;
  expect(scrollListeners(added) - scrollListeners(removed)).toBe(1);
  expect(clock.observed(group)).toBe(true);
});

it("shares a read-before-write frame without sharing strip cancellation", async () => {
  const clock = tabMeasurementClock();
  const first = await renderStrip({ tabs: [TAB] });
  const second = await renderStrip({ tabs: [makeTab(2)] });
  const operations: string[] = [];
  for (const [name, container] of [
    ["first", first],
    ["second", second],
  ] as const) {
    recordMeasurement(tabStrip(container, "-tab__label"), name, operations);
  }
  clock.flush();
  expect(operations).toEqual(["read first", "read second", "write first", "write second"]);

  operations.length = 0;
  tabStrip(first).dispatchEvent(new Event("scroll"));
  tabStrip(second).dispatchEvent(new Event("scroll"));
  unmountStrip(first);
  clock.flush();
  expect(operations).toEqual(["read second", "write second"]);
});

it("measures the visible label when its tooltip wrapper changes", async () => {
  const clock = tabMeasurementClock();
  const container = host();
  for (const labelTooltip of [undefined, "Full label", undefined]) {
    await renderStrip({ container, tabs: [{ ...TAB, label: "A long label", labelTooltip }] });
    const label = tabStrip(container, "-tab__label");
    widths(label, 100, 200);
    await clock.settle(container);
    expect(label.closest("openclaw-tooltip") !== null).toBe(Boolean(labelTooltip));
    expect(overflowState(label)).toEqual([true, true]);
  }
});

it.each(["ltr", "rtl"])("refreshes scroll edges across disconnect/reconnect (%s)", async (dir) => {
  document.documentElement.dir = dir;
  const clock = tabMeasurementClock();
  const container = await renderStrip({ tabs: [TAB] });
  await clock.settle(container, false);
  let contentEdges: [number, number] = [0, 200];
  const measure = () => {
    const group = tabStrip(container)!;
    measureEdges(group, () => [0, 100]);
    const reads = [...group.children].map((child) => measureEdges(child, () => contentEdges));
    return { group, reads };
  };
  let { group, reads } = measure();
  const scroll = () => group.dispatchEvent(new Event("scroll"));
  const readCounts = () => reads.map((read) => read.mock.calls.length);
  const expectReadCount = (count: number) => expect(readCounts()).toEqual(reads.map(() => count));
  clock.flush();
  expect(scrollEdges(group)).toEqual([false, true]);
  reads.forEach((read) => read.mockClear());

  contentEdges = [-100, 100];
  scroll();
  scroll();
  expectReadCount(0);
  clock.flush();
  expectReadCount(1);
  expect(scrollEdges(group)).toEqual([true, false]);

  scroll();
  unmountStrip(container);
  expect(clock.observed(group)).toBe(false);
  reads.forEach((read) => read.mockClear());
  clock.flush();
  scroll();
  clock.flush();
  expectReadCount(0);

  contentEdges = [0, 100];
  await renderStrip({ tabs: [TAB], container });
  await clock.settle(container, false);
  ({ group, reads } = measure());
  clock.flush();
  expect(clock.observed(group)).toBe(true);
  expect(group.classList.contains("has-scroll-left")).toBe(false);
});

it("reorders draggable tabs at the requested edge", async () => {
  document.documentElement.setAttribute("dir", "ltr");
  const onReorder = vi.fn();
  const container = await renderStrip({
    tabs: [
      makeTab(1, { reorderId: "files" }),
      makeTab(2, { reorderId: "browser", draggable: false }),
    ],
    onReorder,
  });
  const [source, target] = renderedTabs(container);
  const dataTransfer = createDataTransferStub();
  measureEdges(target!, () => [100, 180]);

  dispatchDrag(source!, "dragstart", dataTransfer);
  const sourceId = "files";
  expect(tabStrip(container)?.dataset.draggedPanelTab).toBe(sourceId);
  expect(dataTransfer.getData("application/x-openclaw-panel-tab")).toBe(sourceId);
  dispatchDrag(target!, "dragover", dataTransfer, 110);
  flush();
  // Drop clears the preview; capture it first.
  const previewed = target?.classList.contains("is-drop-before");
  dispatchDrag(target!, "drop", dataTransfer, 110);

  expect(source?.draggable).toBe(true);
  expect(previewed).toBe(true);
  expect(onReorder).toHaveBeenCalledWith(sourceId, "browser", "before");
});

it("omits dragging and ignores dragstart for a tab with draggable false", async () => {
  const onReorder = vi.fn();
  const container = await renderStrip({ tabs: [{ ...TAB, draggable: false }], onReorder });
  const tab = renderedTabs(container)[0]!;
  const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };

  expect(tab.hasAttribute("draggable")).toBe(false);
  dispatchDrag(tab, "dragstart", dataTransfer);
  expect(dataTransfer.setData).not.toHaveBeenCalled();
  expect(dataTransfer.effectAllowed).toBe("none");
  expect(tabStrip(container)?.hasAttribute("data-dragged-panel-tab")).toBe(false);
  expect(onReorder).not.toHaveBeenCalled();
});
