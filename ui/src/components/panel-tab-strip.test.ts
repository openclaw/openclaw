/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";
import {
  panelTabStripStyles,
  renderPanelTabStrip,
  type PanelTabStripTab,
} from "./panel-tab-strip.ts";

const TAB: PanelTabStripTab = {
  id: "tab-1",
  domId: "test-tab-1",
  label: "First tab",
  closeLabel: "Close tab: First tab",
};

function renderStrip(options: {
  tabs?: PanelTabStripTab[];
  activeId?: string | null;
  onClose?: (id: string) => void;
  onNew?: () => void;
  onReorder?: (sourceId: string, targetId: string, placement: "before" | "after") => void;
  onSelect?: (id: string) => void;
  separateTabs?: boolean;
  container?: HTMLDivElement;
}) {
  const container = options.container ?? document.createElement("div");
  render(
    renderPanelTabStrip({
      tabs: options.tabs ?? [],
      activeId: options.activeId ?? options.tabs?.[0]?.id ?? null,
      ariaControls: "test-tab-panel",
      onSelect: options.onSelect ?? vi.fn(),
      onClose: options.onClose ?? vi.fn(),
      onNew: options.onNew ?? vi.fn(),
      onReorder: options.onReorder,
      separateTabs: options.separateTabs,
      newLabel: "New tab",
    }),
    container,
  );
  return container;
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
  document.body.replaceChildren();
  document.documentElement.removeAttribute("dir");
  Reflect.deleteProperty(customElements.get("wa-tab-group")?.prototype ?? {}, "updateComplete");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("renderPanelTabStrip", () => {
  it("keeps the new-tab control from shrinking when the strip overflows", () => {
    expect(panelTabStripStyles.cssText).toMatch(/\.tabstrip-new\s*\{[^}]*flex:\s*none/u);
  });

  it("renders an unslotted new button without an empty tab group", () => {
    const onNew = vi.fn();
    const container = renderStrip({ onNew });

    expect(container.querySelector("wa-tab-group")).toBeNull();
    const button = container.querySelector<HTMLButtonElement>(".tabstrip-new");
    expect(button?.hasAttribute("slot")).toBe(false);
    button?.click();
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("slots the new button into a nonempty tab group", () => {
    const container = renderStrip({ tabs: [TAB] });

    expect(container.querySelector("wa-tab-group")).not.toBeNull();
    expect(container.querySelector(".tabstrip-new")?.getAttribute("slot")).toBe("nav");
  });

  it.each([
    { groups: [undefined, undefined, undefined, undefined], before: [2, 3, 4] },
    { groups: ["files", "browser", "browser", "terminal"], before: [2, 4] },
    { groups: ["browser", "browser", "browser", "browser"], before: [] },
  ])("keeps separators only outside adjacent groups ($groups)", ({ groups, before }) => {
    const tabs = groups.map((group, index) => ({
      ...TAB,
      id: `tab-${index + 1}`,
      domId: `test-tab-${index + 1}`,
      group,
    }));
    const container = renderStrip({ tabs, separateTabs: true });
    const separatorTargets = () =>
      [...container.querySelectorAll(".tabstrip-separator")].map(
        (separator) => separator.nextElementSibling?.id,
      );

    expect(separatorTargets()).toEqual(before.map((index) => `test-tab-${index}`));
    renderStrip({ tabs, separateTabs: true, activeId: "tab-2", container });
    expect(separatorTargets()).toEqual(before.map((index) => `test-tab-${index}`));
  });

  it("reports user selection without echoing controlled selection changes", () => {
    const onSelect = vi.fn();
    const tabs = [TAB, { ...TAB, id: "tab-2", domId: "test-tab-2" }];
    const container = renderStrip({ tabs, onSelect });
    const group = container.querySelector("wa-tab-group")!;
    const show = (name: string) =>
      group.dispatchEvent(new CustomEvent("wa-tab-show", { detail: { name } }));

    show(TAB.id);
    expect(onSelect).not.toHaveBeenCalled();
    show("tab-2");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("tab-2");
    renderStrip({ tabs, onSelect, container, activeId: "tab-2" });
    show("tab-2");
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("keeps explicit tab activation separate from selection, key repeats, and close", () => {
    const onActivate = vi.fn();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const container = renderStrip({ tabs: [{ ...TAB, onActivate }], onSelect, onClose });
    const tab = container.querySelector("wa-tab")!;
    tab.click();
    expect(onActivate).toHaveBeenCalledTimes(1);
    for (const key of ["Enter", " "]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      tab.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      tab.dispatchEvent(new KeyboardEvent("keydown", { key, repeat: true, bubbles: true }));
    }
    expect(onActivate).toHaveBeenCalledTimes(3);
    tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    container.querySelector<HTMLButtonElement>(".tabstrip-tab__close")!.click();
    expect(onClose).toHaveBeenCalledExactlyOnceWith(TAB.id);
    expect(onActivate).toHaveBeenCalledTimes(3);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes the requested tab from its labeled close button", () => {
    const onClose = vi.fn();
    const container = renderStrip({ tabs: [TAB], onClose });
    const closeButton = container.querySelector<HTMLButtonElement>(".tabstrip-tab__close");

    expect(closeButton?.hasAttribute("title")).toBe(false);
    expect(closeButton?.getAttribute("aria-label")).toBe(TAB.closeLabel);
    closeButton?.click();
    expect(onClose).toHaveBeenCalledWith(TAB.id);
  });

  it("keeps only the active tab close action in the keyboard order", () => {
    const container = renderStrip({
      tabs: [TAB, { ...TAB, id: "tab-2", domId: "test-tab-2", label: "Second tab" }],
      activeId: "tab-2",
    });
    const closeButtons = [...container.querySelectorAll<HTMLButtonElement>(".tabstrip-tab__close")];

    expect(closeButtons.map((button) => button.tabIndex)).toEqual([-1, 0]);
  });

  it("closes a tab on middle click", () => {
    const onClose = vi.fn();
    const container = renderStrip({ tabs: [TAB], onClose });

    container.querySelector("wa-tab")?.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
    expect(onClose).toHaveBeenCalledWith(TAB.id);
  });

  it("batches overflow reads after content commits and skips unchanged renders", async () => {
    const clock = tabMeasurementClock();
    const container = document.createElement("div");
    document.body.append(container);
    const tabs = [TAB, { ...TAB, id: "tab-2", domId: "test-tab-2" }];
    renderStrip({ tabs, container });
    const group = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
      "wa-tab-group",
    )!;
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
    await group.updateComplete;
    clock.flush();
    operations.length = 0;

    renderStrip({ tabs, container });
    await Promise.resolve();
    clock.flush();
    expect(operations).toEqual([]);

    renderStrip({
      tabs: tabs.map((tab) => Object.assign({}, tab, { label: "Long label" })),
      container,
    });
    expect(operations).toEqual([]);
    await Promise.resolve();
    clock.flush();
    expect(operations).toEqual(["read 0", "read 1", "write 0", "write 1"]);
    expect(labels.every((label) => label.hasAttribute("data-tooltip-overflow"))).toBe(true);
    expect(
      labels.every((label) => label.parentElement?.classList.contains("has-label-overflow")),
    ).toBe(true);

    renderStrip({
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
    render(nothing, container);
  });

  it.each(["ltr", "rtl"])(
    "refreshes physical scroll edges and releases measurements across connection changes (%s)",
    async (dir) => {
      document.documentElement.dir = dir;
      const clock = tabMeasurementClock();
      const container = document.createElement("div");
      document.body.append(container);
      const template = renderPanelTabStrip({
        tabs: [TAB],
        activeId: TAB.id,
        ariaControls: "test-tab-panel",
        onSelect: vi.fn(),
        onClose: vi.fn(),
        onNew: vi.fn(),
        newLabel: "New tab",
      });
      const root = render(template, container);
      const group = container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
        "wa-tab-group",
      )!;
      await group.updateComplete;
      const scroller = group.shadowRoot!.querySelector<HTMLElement>('[part~="tabs"]')!;
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
      root.setConnected(false);
      expect(clock.observed(scroller)).toBe(false);
      reads.forEach((read) => read.mockClear());
      clock.flush();
      scroller.dispatchEvent(new Event("scroll"));
      clock.flush();
      expect(reads.every((read) => read.mock.calls.length === 0)).toBe(true);

      contentLeft = 0;
      root.setConnected(true);
      await group.updateComplete;
      clock.flush();
      expect(clock.observed(scroller)).toBe(true);
      expect(group.classList.contains("has-scroll-left")).toBe(false);
      render(nothing, container);
    },
  );

  // Installation waits for the group's shadow scroller. Renders during that
  // wait must not accumulate subscriptions that cleanup can no longer reach.
  it("keeps one live scroll-edge listener no matter how many renders race", async () => {
    const gate = createDeferred<boolean>();
    const groupPrototype = customElements.get("wa-tab-group")?.prototype;
    expect(groupPrototype).toBeDefined();
    Object.defineProperty(groupPrototype!, "updateComplete", {
      configurable: true,
      get: () => gate.promise,
    });

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
      renderStrip({ tabs, container });
    }

    const group = container.querySelector<
      HTMLElement & { getUpdateComplete?: () => Promise<unknown> }
    >("wa-tab-group");
    expect(group).not.toBeNull();
    await group?.getUpdateComplete?.();
    const scroller = group?.shadowRoot?.querySelector<HTMLElement>('[part~="tabs"]');
    expect(scroller).toBeDefined();
    const added = vi.spyOn(scroller!, "addEventListener");
    const removed = vi.spyOn(scroller!, "removeEventListener");

    gate.resolve(true);
    await gate.promise;
    await Promise.resolve();

    const scrollListeners = (spy: typeof added) =>
      spy.mock.calls.filter(([type]) => type === "scroll").length;
    expect(scrollListeners(added) - scrollListeners(removed)).toBe(1);
    expect(observers.filter((entry) => entry.live && entry.target === scroller)).toHaveLength(1);
  });

  // "before"/"after" are array order, so the physical half that means "before"
  // flips with the writing direction. Both rows exercise the same pointer x.
  it.each([
    { dir: "ltr", placement: "before", reorderIds: undefined },
    { dir: "rtl", placement: "after", reorderIds: undefined },
    { dir: "ltr", placement: "before", reorderIds: ["files", "browser"] },
  ])(
    "reorders draggable tabs at the requested edge ($dir, $reorderIds)",
    ({ dir, placement, reorderIds }) => {
      document.documentElement.setAttribute("dir", dir);
      const onReorder = vi.fn();
      // Direction is inherited, so the strip has to be in the document for
      // getComputedStyle to report the writing direction under test.
      const host = document.createElement("div");
      document.body.append(host);
      const container = renderStrip({
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
      const [source, target] = [...container.querySelectorAll<HTMLElement>("wa-tab")];
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
      expect(container.querySelector<HTMLElement>("wa-tab-group")?.dataset.draggedPanelTab).toBe(
        sourceId,
      );
      expect(dataTransfer.getData("application/x-openclaw-panel-tab")).toBe(sourceId);
      dispatchDrag(target!, "dragover", 110);
      // The indicator must preview the same edge the drop will use; `drop` clears
      // it, so the class is read while the drag is still over the target.
      const previewed = target?.classList.contains(`is-drop-${placement}`);
      dispatchDrag(target!, "drop", 110);

      expect(source?.draggable).toBe(true);
      expect(previewed).toBe(true);
      expect(onReorder).toHaveBeenCalledWith(sourceId, reorderIds?.[1] ?? "tab-2", placement);
    },
  );

  it("omits dragging and ignores dragstart for a tab with draggable false", () => {
    const onReorder = vi.fn();
    const container = renderStrip({
      tabs: [{ ...TAB, draggable: false }],
      onReorder,
    });
    const tab = container.querySelector("wa-tab")!;
    const dataTransfer = { setData: vi.fn(), effectAllowed: "none" };
    const event = new MouseEvent("dragstart", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });

    expect(tab.hasAttribute("draggable")).toBe(false);
    tab.dispatchEvent(event);
    expect(dataTransfer.setData).not.toHaveBeenCalled();
    expect(dataTransfer.effectAllowed).toBe("none");
    expect(container.querySelector("wa-tab-group")?.hasAttribute("data-dragged-panel-tab")).toBe(
      false,
    );
    expect(onReorder).not.toHaveBeenCalled();
  });
});
