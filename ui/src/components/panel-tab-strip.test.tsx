/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
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

type StripOptions = Partial<PanelTabStripProps<PanelTabStripTab>> & {
  container?: HTMLDivElement;
};
const strips = new Map<
  HTMLDivElement,
  {
    update: (props: PanelTabStripProps<PanelTabStripTab>) => void;
    unmount: () => void;
  }
>();

async function renderStrip(options: StripOptions) {
  const container = options.container ?? host();
  const props: PanelTabStripProps<PanelTabStripTab> = {
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

function tabStrip(container: ParentNode) {
  return container.querySelector<HTMLElement>(".tabstrip");
}

function renderedTabs(container: ParentNode) {
  return [...container.querySelectorAll<HTMLElement>(".tabstrip-tab")];
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

function tabMeasurementClock() {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const observers = new Set<ControlledResizeObserver>();
  class ControlledResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.add(this);
    }
    observe = (target: Element) => {
      this.targets.add(target);
    };
    unobserve = (target: Element) => {
      this.targets.delete(target);
    };
    disconnect = () => this.targets.clear();
  }
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
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
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    },
    resize(target: Element) {
      for (const observer of observers) {
        if (observer.targets.has(target)) {
          observer.callback([], observer);
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
  expect(container.querySelector(".tabstrip-new-control")?.getAttribute("slot")).toBe("nav");
  const button = container.querySelector<HTMLButtonElement>(".tabstrip-new-control button")!;
  button.click();
  expect(onAction).toHaveBeenLastCalledWith("First action");
  control.textContent = "Updated action";
  await renderStrip({ tabs: [{ ...TAB, label: "Updated tab" }], container, newControl: control });
  expect(container.querySelector(".tabstrip-new-control button")).toBe(button);
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
  const iconElement = container.querySelector(".tabstrip-tab__icon span");
  const onSelect = vi.fn();
  await renderStrip({
    tabs: tabs.map((tab) => Object.assign({}, tab)),
    activeId: "tab-2",
    onSelect,
    container,
  });
  expect(container.querySelector(".tabstrip-tab__icon span")).toBe(iconElement);
  renderedTabs(container)
    .find((tab) => tab.dataset.tabValue === TAB.id)
    ?.click();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(TAB.id);
  icon.textContent = "Updated icon";
  flush();
  expect(container.querySelector(".tabstrip-tab__icon span")).toBe(iconElement);
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

it("closes the requested tab from its labeled close button", async () => {
  const onClose = vi.fn();
  const container = await renderStrip({ tabs: [TAB], onClose });
  const closeButton = container.querySelector<HTMLButtonElement>(".tabstrip-tab__close");

  expect(closeButton?.hasAttribute("title")).toBe(false);
  expect(closeButton?.getAttribute("aria-label")).toBe(TAB.closeLabel);
  closeButton?.click();
  expect(onClose).toHaveBeenCalledWith(TAB.id);
});

it("batches overflow reads after content commits and skips unchanged renders", async () => {
  const clock = tabMeasurementClock();
  const tabs = [TAB, makeTab(2)];
  const container = await renderStrip({ tabs });
  const group = tabStrip(container)!;
  const labels = [...group.querySelectorAll<HTMLElement>(".tabstrip-tab__label")];
  const operations: string[] = [];
  for (const [index, label] of labels.entries()) {
    widths(label, 100, () => {
      operations.push(`read ${index}`);
      return label.textContent!.startsWith("Long") ? 200 : 80;
    });
    const toggle = label.classList.toggle.bind(label.classList);
    vi.spyOn(label.classList, "toggle").mockImplementation((name, force) => {
      operations.push(`write ${index}`);
      return toggle(name, force);
    });
  }
  await clock.settle(container);
  operations.length = 0;

  await renderStrip({ tabs, container });
  await clock.settle(container);
  expect(operations).toEqual([]);

  await renderStrip({
    tabs: tabs.map((tab) => Object.assign({}, tab, { label: "Long label" })),
    container,
  });
  expect(operations).toEqual([]);
  await clock.settle(container);
  expect(operations).toEqual(["read 0", "read 1", "write 0", "write 1"]);
  expect(labels.map(overflowState)).toEqual([
    [true, true],
    [true, true],
  ]);

  await renderStrip({
    tabs: tabs.map((tab) =>
      Object.assign({}, tab, { label: "Long label", className: "is-exited" }),
    ),
    container,
  });
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
  unmountStrip(container);
});

it("measures the visible label when its tooltip wrapper changes", async () => {
  const clock = tabMeasurementClock();
  const container = host();
  for (const labelTooltip of [undefined, "Full label", undefined]) {
    await renderStrip({
      container,
      tabs: [{ ...TAB, label: "A long label", labelTooltip }],
    });
    const label = container.querySelector<HTMLElement>(".tabstrip-tab__label")!;
    widths(label, 100, 200);
    await clock.settle(container);
    expect(label.closest("openclaw-tooltip") !== null).toBe(Boolean(labelTooltip));
    expect(overflowState(label)).toEqual([true, true]);
  }
  unmountStrip(container);
});

it.each(["ltr", "rtl"])(
  "refreshes physical scroll edges and releases measurements across connection changes (%s)",
  async (dir) => {
    document.documentElement.dir = dir;
    const clock = tabMeasurementClock();
    const container = await renderStrip({ tabs: [TAB] });
    await clock.settle(container, false);
    let contentLeft = 0;
    let contentRight = 200;
    const measure = () => {
      const group = tabStrip(container)!;
      measureEdges(group, () => [0, 100]);
      const reads = [...group.children].map((child) =>
        measureEdges(child, () => [contentLeft, contentRight]),
      );
      return { group, reads };
    };
    let { group, reads } = measure();
    const scroll = () => group.dispatchEvent(new Event("scroll"));
    const readCounts = () => reads.map((read) => read.mock.calls.length);
    const expectReadCount = (count: number) => expect(readCounts()).toEqual(reads.map(() => count));
    clock.flush();
    expect(scrollEdges(group)).toEqual([false, true]);
    reads.forEach((read) => read.mockClear());

    contentLeft = -100;
    contentRight = 100;
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

    contentLeft = 0;
    await renderStrip({ tabs: [TAB], container });
    await clock.settle(container, false);
    ({ group, reads } = measure());
    clock.flush();
    expect(clock.observed(group)).toBe(true);
    expect(group.classList.contains("has-scroll-left")).toBe(false);
    unmountStrip(container);
  },
);

it("keeps one live scroll-edge listener no matter how many renders race", async () => {
  const clock = tabMeasurementClock();
  const added = vi.spyOn(HTMLElement.prototype, "addEventListener");
  const removed = vi.spyOn(HTMLElement.prototype, "removeEventListener");

  const container = host();
  const tabs = [TAB, makeTab(2)];
  for (let index = 0; index < 4; index += 1) {
    await renderStrip({ tabs, container });
  }

  const scroller = tabStrip(container)!;
  await clock.settle(container);

  const scrollListeners = (spy: typeof added) =>
    spy.mock.calls.filter(
      ([type], index) => type === "scroll" && spy.mock.contexts[index] === scroller,
    ).length;
  expect(scrollListeners(added) - scrollListeners(removed)).toBe(1);
  expect(clock.observed(scroller)).toBe(true);
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
  const dispatchDrag = (element: HTMLElement, type: string, clientX: number) => {
    const event = new MouseEvent(type, { bubbles: true, clientX, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    element.dispatchEvent(event);
  };
  measureEdges(target!, () => [100, 180]);

  dispatchDrag(source!, "dragstart", 0);
  const sourceId = "files";
  expect(tabStrip(container)?.dataset.draggedPanelTab).toBe(sourceId);
  expect(dataTransfer.getData("application/x-openclaw-panel-tab")).toBe(sourceId);
  dispatchDrag(target!, "dragover", 110);
  flush();
  // Drop clears the preview; capture it first.
  const previewed = target?.classList.contains("is-drop-before");
  dispatchDrag(target!, "drop", 110);

  expect(source?.draggable).toBe(true);
  expect(previewed).toBe(true);
  expect(onReorder).toHaveBeenCalledWith(sourceId, "browser", "before");
});

it("omits dragging and ignores dragstart for a tab with draggable false", async () => {
  const onReorder = vi.fn();
  const container = await renderStrip({
    tabs: [{ ...TAB, draggable: false }],
    onReorder,
  });
  const tab = renderedTabs(container)[0]!;
  const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
  const event = new MouseEvent("dragstart", { bubbles: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });

  expect(tab.hasAttribute("draggable")).toBe(false);
  tab.dispatchEvent(event);
  expect(dataTransfer.setData).not.toHaveBeenCalled();
  expect(dataTransfer.effectAllowed).toBe("none");
  expect(tabStrip(container)?.hasAttribute("data-dragged-panel-tab")).toBe(false);
  expect(onReorder).not.toHaveBeenCalled();
});
