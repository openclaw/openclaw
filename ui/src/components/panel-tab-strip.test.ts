/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { ref } from "lit/directives/ref.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createDataTransferStub } from "../test-helpers/drag-data.ts";
import {
  renderPanelTabStrip,
  type PanelTabStripTab,
  type PanelTabStripParams,
} from "./panel-tab-strip.ts";

const TAB: PanelTabStripTab = {
  id: "tab-1",
  domId: "test-tab-1",
  label: "First tab",
  closeLabel: "Close tab: First tab",
};

async function renderStrip(options: {
  tabs?: PanelTabStripTab[];
  activeId?: string | null;
  onClose?: (id: string) => void;
  onNew?: () => void;
  onReorder?: (sourceId: string, targetId: string, placement: "before" | "after") => void;
  onSelect?: (id: string) => void;
  separateTabs?: boolean;
  newControl?: PanelTabStripParams["newControl"];
  container?: HTMLDivElement;
  host?: object;
}) {
  const container = options.container ?? document.body.appendChild(document.createElement("div"));
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
      newControl: options.newControl,
    }),
    container,
    { host: options.host },
  );
  await panelBridge(container).updateComplete;
  return container;
}

function panelBridge(container: ParentNode) {
  return container.querySelector<HTMLElement & { updateComplete: Promise<boolean> }>(
    "openclaw-panel-tab-strip",
  )!;
}

function tabStrip(container: ParentNode) {
  return container.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>(".tabstrip");
}

function renderedTabs(container: ParentNode) {
  return [...container.querySelectorAll<HTMLElement>(".tabstrip-tab")];
}

async function settleTabStrip(container: ParentNode) {
  await panelBridge(container).updateComplete;
  const strip = tabStrip(container);
  expect(strip).not.toBeNull();
  await strip!.updateComplete;
}

function tabViewport(container: ParentNode) {
  const viewport = tabStrip(container)?.shadowRoot?.querySelector<HTMLElement>('[part~="tabs"]');
  if (!viewport) {
    throw new Error("expected rendered tab strip viewport");
  }
  return viewport;
}

function deferTabLayout() {
  const gate = createDeferred<boolean>();
  const prototype = customElements.get("wa-tab-group")?.prototype;
  expect(prototype).toBeDefined();
  Object.defineProperty(prototype!, "updateComplete", {
    configurable: true,
    get: () => gate.promise,
  });
  return gate;
}

function resetTabLayout() {
  Reflect.deleteProperty(customElements.get("wa-tab-group")?.prototype ?? {}, "updateComplete");
}

async function renderTabViewportBeforeLayout(container: ParentNode) {
  await panelBridge(container).updateComplete;
  const strip = container.querySelector<
    HTMLElement & { getUpdateComplete: () => Promise<unknown> }
  >(".tabstrip");
  expect(strip).not.toBeNull();
  // Set up the renderer's viewport without releasing the held layout completion.
  await strip!.getUpdateComplete();
  return tabViewport(container);
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

afterEach(async () => {
  const bridges = [
    ...document.querySelectorAll<HTMLElement & { updateComplete: Promise<boolean> }>(
      "openclaw-panel-tab-strip",
    ),
  ];
  document.body.replaceChildren();
  await Promise.all(bridges.map((bridge) => bridge.updateComplete));
  document.documentElement.removeAttribute("dir");
  resetTabLayout();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("renderPanelTabStrip", () => {
  it("slots new controls and preserves interactive Lit content across updates", async () => {
    const renderHost = {};
    const container = await renderStrip({ tabs: [TAB], host: renderHost });

    expect(tabStrip(container)).not.toBeNull();
    expect(container.querySelector(".tabstrip-new")?.getAttribute("slot")).toBe("nav");
    const onAction = vi.fn();
    const contentRef = vi.fn();
    const unboundAction = vi.fn(function (event: Event) {
      onAction((event.currentTarget as HTMLButtonElement).textContent);
    });
    const control = (label: string) =>
      html`<button ${ref(contentRef)} @click=${unboundAction}>${label}</button>`;
    await renderStrip({
      tabs: [TAB],
      container,
      host: renderHost,
      newControl: control("First action"),
    });
    const button = container.querySelector<HTMLButtonElement>(".tabstrip-new-control button")!;
    button.click();
    expect(onAction).toHaveBeenLastCalledWith("First action");
    expect(unboundAction.mock.contexts.at(-1)).toBe(renderHost);
    expect(contentRef.mock.contexts.at(-1)).toBe(renderHost);
    await renderStrip({
      tabs: [{ ...TAB, label: "Updated tab" }],
      container,
      host: renderHost,
      newControl: control("Updated action"),
    });
    expect(container.querySelector(".tabstrip-new-control button")).toBe(button);
    expect(button.textContent).toBe("Updated action");
    button.click();
    expect(onAction).toHaveBeenLastCalledWith("Updated action");
    expect(unboundAction.mock.contexts.at(-1)).toBe(renderHost);
    const bridge = panelBridge(container);
    render(nothing, container);
    await bridge.updateComplete;
    expect(contentRef).toHaveBeenLastCalledWith(undefined);
    expect(contentRef.mock.contexts.at(-1)).toBe(renderHost);
  });

  it.each([{ groups: ["files", "browser", "browser", "terminal"], before: [2, 4] }])(
    "keeps separators only outside adjacent groups ($groups)",
    async ({ groups, before }) => {
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
    },
  );

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
    render(nothing, container);
  });

  it.each(["rtl"])(
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
      render(template, container);
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
      const bridge = panelBridge(container);
      bridge.remove();
      await bridge.updateComplete;
      expect(clock.observed(scroller)).toBe(false);
      reads.forEach((read) => read.mockClear());
      clock.flush();
      scroller.dispatchEvent(new Event("scroll"));
      clock.flush();
      expect(reads.every((read) => read.mock.calls.length === 0)).toBe(true);

      contentLeft = 0;
      container.append(bridge);
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
      render(nothing, container);
    },
  );

  // Installation waits for the group's shadow scroller. Renders during that
  // wait must not accumulate subscriptions that cleanup can no longer reach.
  it("keeps one live scroll-edge listener no matter how many renders race", async () => {
    const gate = deferTabLayout();

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

    const scroller = await renderTabViewportBeforeLayout(container);
    const added = vi.spyOn(scroller, "addEventListener");
    const removed = vi.spyOn(scroller, "removeEventListener");

    gate.resolve(true);
    await gate.promise;
    await settleTabStrip(container);

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
  ])(
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
