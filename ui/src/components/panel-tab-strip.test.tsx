/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import {
  PanelTabStrip,
  type SolidPanelTabStripTab as PanelTabStripTab,
  type PanelTabStripProps,
} from "./panel-tab-strip-solid.tsx";

const TAB: PanelTabStripTab = {
  id: "tab-1",
  domId: "test-tab-1",
  label: "First tab",
  closeLabel: "Close tab: First tab",
};

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
  const container = options.container ?? document.body.appendChild(document.createElement("div"));
  const props: PanelTabStripProps<PanelTabStripTab> = {
    tabs: options.tabs ?? [],
    activeId: options.activeId ?? options.tabs?.[0]?.id ?? null,
    ariaControls: "test-tab-panel",
    onSelect: options.onSelect ?? vi.fn(),
    onClose: options.onClose ?? vi.fn(),
    onNew: options.onNew ?? vi.fn(),
    onReorder: options.onReorder,
    separateTabs: options.separateTabs,
    newLabel: "New tab",
    newControl: options.newControl,
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

function tabStrip(container: ParentNode) {
  return container.querySelector<HTMLElement>(".tabstrip");
}

function renderedTabs(container: ParentNode) {
  return [...container.querySelectorAll<HTMLElement>(".tabstrip-tab")];
}

async function settleTabStrip(container: ParentNode) {
  flush();
  const strip = tabStrip(container);
  expect(strip).not.toBeNull();
  await Promise.resolve();
}

function tabViewport(container: ParentNode) {
  const viewport = tabStrip(container);
  if (!viewport) {
    throw new Error("expected rendered tab strip viewport");
  }
  return viewport;
}

function requestTabSelection(container: ParentNode, id: string) {
  renderedTabs(container)
    .find((tab) => tab.dataset.tabValue === id)
    ?.click();
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
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  return {
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

describe("PanelTabStrip", () => {
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
    const tabs = [
      { ...TAB, icon },
      { ...TAB, id: "tab-2", domId: "test-tab-2" },
    ];
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
    requestTabSelection(container, TAB.id);
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
    const tabs = groups.map((group, index) => ({
      ...TAB,
      id: `tab-${index + 1}`,
      domId: `test-tab-${index + 1}`,
      group,
    }));
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
    const container = document.createElement("div");
    document.body.append(container);
    const tabs = [TAB, { ...TAB, id: "tab-2", domId: "test-tab-2" }];
    await renderStrip({ tabs, container });
    const group = tabStrip(container)!;
    const labels = [...group.querySelectorAll<HTMLElement>(".tabstrip-tab__label")];
    const operations: string[] = [];
    for (const [index, label] of labels.entries()) {
      Object.defineProperties(label, {
        clientWidth: { configurable: true, value: 100 },
        scrollWidth: {
          configurable: true,
          get: () => {
            operations.push(`read ${index}`);
            return label.textContent!.startsWith("Long") ? 200 : 80;
          },
        },
      });
      const toggle = label.classList.toggle.bind(label.classList);
      vi.spyOn(label.classList, "toggle").mockImplementation((name, force) => {
        operations.push(`write ${index}`);
        return toggle(name, force);
      });
    }
    await settleTabStrip(container);
    clock.flush();
    operations.length = 0;

    await renderStrip({ tabs, container });
    await settleTabStrip(container);
    clock.flush();
    expect(operations).toEqual([]);

    await renderStrip({
      tabs: tabs.map((tab) => Object.assign({}, tab, { label: "Long label" })),
      container,
    });
    expect(operations).toEqual([]);
    await settleTabStrip(container);
    clock.flush();
    expect(operations).toEqual(["read 0", "read 1", "write 0", "write 1"]);
    expect(labels.every((label) => label.hasAttribute("data-tooltip-overflow"))).toBe(true);
    expect(
      labels.every((label) => label.parentElement?.classList.contains("has-label-overflow")),
    ).toBe(true);

    await renderStrip({
      tabs: tabs.map((tab) =>
        Object.assign({}, tab, { label: "Long label", className: "is-exited" }),
      ),
      container,
    });
    clock.flush();
    expect(
      labels.every((label) => label.parentElement?.classList.contains("has-label-overflow")),
    ).toBe(true);

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

  it.each(["ltr", "rtl"])(
    "refreshes physical scroll edges and releases measurements across connection changes (%s)",
    async (dir) => {
      document.documentElement.dir = dir;
      const clock = tabMeasurementClock();
      const container = document.createElement("div");
      document.body.append(container);
      await renderStrip({ tabs: [TAB], container });
      await settleTabStrip(container);
      let group = tabStrip(container)!;
      let scroller = tabViewport(container);
      vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 100,
      } as DOMRect);
      let contentLeft = 0;
      let contentRight = 200;
      const reads = [...group.children].map((child) =>
        vi
          .spyOn(child, "getBoundingClientRect")
          .mockImplementation(() => ({ left: contentLeft, right: contentRight }) as DOMRect),
      );
      clock.flush();
      expect(group.classList.contains("has-scroll-left")).toBe(false);
      expect(group.classList.contains("has-scroll-right")).toBe(true);
      reads.forEach((read) => read.mockClear());

      contentLeft = -100;
      contentRight = 100;
      scroller.dispatchEvent(new Event("scroll"));
      scroller.dispatchEvent(new Event("scroll"));
      expect(reads.every((read) => read.mock.calls.length === 0)).toBe(true);
      clock.flush();
      expect(reads.every((read) => read.mock.calls.length === 1)).toBe(true);
      expect(group.classList.contains("has-scroll-left")).toBe(true);
      expect(group.classList.contains("has-scroll-right")).toBe(false);

      scroller.dispatchEvent(new Event("scroll"));
      unmountStrip(container);
      expect(clock.observed(scroller)).toBe(false);
      reads.forEach((read) => read.mockClear());
      clock.flush();
      scroller.dispatchEvent(new Event("scroll"));
      clock.flush();
      expect(reads.every((read) => read.mock.calls.length === 0)).toBe(true);

      contentLeft = 0;
      await renderStrip({ tabs: [TAB], container });
      await settleTabStrip(container);
      group = tabStrip(container)!;
      scroller = tabViewport(container);
      vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
        left: 0,
        right: 100,
      } as DOMRect);
      for (const child of group.children) {
        vi.spyOn(child, "getBoundingClientRect").mockImplementation(
          () => ({ left: contentLeft, right: contentRight }) as DOMRect,
        );
      }
      clock.flush();
      expect(clock.observed(scroller)).toBe(true);
      expect(group.classList.contains("has-scroll-left")).toBe(false);
      unmountStrip(container);
    },
  );

  // Repeated prop updates retain one native measurement owner.
  it("keeps one live scroll-edge listener no matter how many renders race", async () => {
    const added = vi.spyOn(HTMLElement.prototype, "addEventListener");
    const removed = vi.spyOn(HTMLElement.prototype, "removeEventListener");

    const observers: { target: Element | null; live: boolean }[] = [];
    class CountingResizeObserver {
      private readonly record = { target: null as Element | null, live: true };
      constructor(_callback: ResizeObserverCallback) {
        observers.push(this.record);
      }
      observe(target: Element) {
        this.record.target = target;
      }
      unobserve() {}
      disconnect() {
        this.record.live = false;
      }
    }
    vi.stubGlobal("ResizeObserver", CountingResizeObserver);

    const container = document.createElement("div");
    document.body.append(container);
    const tabs = [TAB, { ...TAB, id: "tab-2", domId: "test-tab-2", label: "Second tab" }];
    const renderCount = 4;
    for (let index = 0; index < renderCount; index += 1) {
      await renderStrip({ tabs, container });
    }

    const scroller = tabViewport(container);
    await settleTabStrip(container);

    const scrollListeners = (spy: typeof added) =>
      spy.mock.calls.filter(
        ([type], index) => type === "scroll" && spy.mock.contexts[index] === scroller,
      ).length;
    expect(scrollListeners(added) - scrollListeners(removed)).toBe(1);
    expect(observers.filter((entry) => entry.live && entry.target === scroller)).toHaveLength(1);
  });

  it.each([{ dir: "ltr", placement: "before", reorderIds: ["files", "browser"] }])(
    "reorders draggable tabs at the requested edge ($dir, $reorderIds)",
    async ({ dir, placement, reorderIds }) => {
      document.documentElement.setAttribute("dir", dir);
      const onReorder = vi.fn();
      // Direction is inherited, so the strip has to be in the document for
      // getComputedStyle to report the writing direction under test.
      const host = document.createElement("div");
      document.body.append(host);
      const container = await renderStrip({
        tabs: [
          { ...TAB, reorderId: reorderIds?.[0] },
          {
            ...TAB,
            id: "tab-2",
            domId: "test-tab-2",
            label: "Second tab",
            reorderId: reorderIds?.[1],
            draggable: reorderIds ? false : undefined,
          },
        ],
        onReorder,
        container: host,
      });
      const [source, target] = renderedTabs(container);
      const dataTransfer = createDataTransferStub();
      const dispatchDrag = (element: HTMLElement, type: string, clientX: number) => {
        const event = new MouseEvent(type, { bubbles: true, clientX, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
        element.dispatchEvent(event);
      };
      vi.spyOn(target!, "getBoundingClientRect").mockReturnValue({
        left: 100,
        width: 80,
      } as DOMRect);

      dispatchDrag(source!, "dragstart", 0);
      const sourceId = reorderIds?.[0] ?? "tab-1";
      expect(tabStrip(container)?.dataset.draggedPanelTab).toBe(sourceId);
      expect(dataTransfer.getData("application/x-openclaw-panel-tab")).toBe(sourceId);
      dispatchDrag(target!, "dragover", 110);
      flush();
      // The indicator must preview the same edge the drop will use; `drop` clears
      // it, so the class is read while the drag is still over the target.
      const previewed = target?.classList.contains(`is-drop-${placement}`);
      dispatchDrag(target!, "drop", 110);

      expect(source?.draggable).toBe(true);
      expect(previewed).toBe(true);
      expect(onReorder).toHaveBeenCalledWith(sourceId, reorderIds?.[1] ?? "tab-2", placement);
    },
  );

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
});
