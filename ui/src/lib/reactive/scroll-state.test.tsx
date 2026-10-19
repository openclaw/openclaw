/* @vitest-environment jsdom */
import { createRoot, createSignal, flush, For } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useScrollState } from "../../components/solid/scroll-state.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createScrollPosition, createScrollStateRef } from "./scroll-state.ts";

const observers: TestResizeObserver[] = [];
const cleanup: Array<() => void> = [];

class TestResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(element: Element) {
    this.targets.add(element);
  }
  unobserve(element: Element) {
    this.targets.delete(element);
  }
  disconnect() {
    this.targets.clear();
  }
  deliver(element: Element) {
    this.callback(
      [
        {
          target: element,
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
          contentRect: new DOMRectReadOnly(),
        },
      ],
      this,
    );
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});
afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose();
  }
  observers.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function geometry(element: HTMLElement, horizontal = false) {
  const values = { extent: 300, viewport: 100, offset: 0 };
  Object.defineProperties(element, {
    [horizontal ? "scrollWidth" : "scrollHeight"]: { get: () => values.extent },
    [horizontal ? "clientWidth" : "clientHeight"]: { get: () => values.viewport },
    [horizontal ? "scrollLeft" : "scrollTop"]: { get: () => values.offset },
  });
  return values;
}

function reflect(element: HTMLElement, state: { scrollable: boolean; atEnd: boolean }) {
  element.dataset.scrollable = String(state.scrollable);
  element.dataset.atEnd = String(state.atEnd);
}

it("keeps horizontal scroll affordances on Solid-bound elements", () => {
  const view = mountSolid(() => <div role="region" ref={useScrollState(true)} />);
  cleanup.push(view.unmount);
  const element = view.getByRole("region");
  const values = geometry(element, true);
  flush();
  vi.advanceTimersToNextFrame();
  expect(element.dataset).toMatchObject({
    scrollable: "true",
    atStart: "true",
    atEnd: "false",
  });
  values.offset = 200;
  element.dispatchEvent(new Event("scroll"));
  vi.advanceTimersToNextFrame();
  expect(element.dataset).toMatchObject({
    scrollable: "true",
    atStart: "false",
    atEnd: "true",
  });
});

it("moves observation to the rendered replacement and ignores the old pending layout", () => {
  const [identity, setIdentity] = createSignal(0);
  const view = mountSolid(() => {
    const ref = createScrollStateRef(reflect);
    return (
      <For each={[identity()]}>
        {() => <div role="region" aria-label="Scroll content" ref={ref} />}
      </For>
    );
  });
  cleanup.push(view.unmount);
  const first = view.getByRole("region", { name: "Scroll content" });
  const firstGeometry = geometry(first);
  flush();
  vi.advanceTimersToNextFrame();
  expect(first.dataset).toMatchObject({ scrollable: "true", atEnd: "false" });
  const oldObserver = observers.at(-1)!;

  firstGeometry.offset = 200;
  first.dispatchEvent(new Event("scroll"));
  setIdentity(1);
  flush();
  const second = view.getByRole("region", { name: "Scroll content" });
  geometry(second).extent = 100;
  // A queued browser notification can arrive after unobserve and element replacement.
  oldObserver.deliver(first);
  vi.advanceTimersToNextFrame();

  expect(second).not.toBe(first);
  expect(first.dataset.atEnd).toBe("false");
  expect(second.dataset).toMatchObject({ scrollable: "false", atEnd: "true" });
  expect(observers.filter((observer) => observer.targets.has(second))).toHaveLength(1);
  expect(observers.every((observer) => !observer.targets.has(first))).toBe(true);
});

it("resamples content on reveal and releases live external targets when disposed", () => {
  const element = document.body.appendChild(document.createElement("div"));
  cleanup.push(() => element.remove());
  const values = geometry(element, true);
  const publish = vi.fn(reflect);
  const [presented, setPresented] = createSignal(true);
  const [content, setContent] = createSignal("long path");
  const binding = createRoot((dispose) => ({
    dispose,
    ref: createScrollStateRef(publish, { presented, content, horizontal: true }),
  }));
  cleanup.push(binding.dispose);
  binding.ref(element);
  flush();
  vi.advanceTimersToNextFrame();
  expect(element.dataset).toMatchObject({ scrollable: "true", atEnd: "false" });
  const oldObserver = observers.at(-1)!;

  values.offset = 200;
  element.dispatchEvent(new Event("scroll"));
  setPresented(false);
  flush();
  values.extent = 100;
  values.offset = 0;
  setContent("short path");
  flush();
  oldObserver.deliver(element);
  vi.advanceTimersToNextFrame();
  expect(element.dataset.atEnd).toBe("false");
  expect(observers.every((observer) => observer.targets.size === 0)).toBe(true);

  setPresented(true);
  flush();
  vi.advanceTimersToNextFrame();
  expect(element.dataset).toMatchObject({ scrollable: "false", atEnd: "true" });
  publish.mockClear();
  values.extent = 400;
  setContent("a longer path");
  flush();
  vi.advanceTimersToNextFrame();
  expect(element.dataset).toMatchObject({ scrollable: "true", atEnd: "false" });
  expect(publish).toHaveBeenCalledExactlyOnceWith(element, {
    scrollable: true,
    atStart: true,
    atEnd: false,
  });
  expect(observers.filter((observer) => observer.targets.has(element))).toHaveLength(1);

  values.offset = 300;
  element.dispatchEvent(new Event("scroll"));
  const retiringObserver = observers.at(-1)!;
  binding.dispose();
  retiringObserver.deliver(element);
  element.dispatchEvent(new Event("scroll"));
  vi.advanceTimersToNextFrame();
  expect(element.isConnected).toBe(true);
  expect(element.dataset.atEnd).toBe("false");
  expect(observers.every((observer) => observer.targets.size === 0)).toBe(true);
});

it("defers bounded reveal and cancels replaced, cleared, and disposed requests", () => {
  const ancestor = document.body.appendChild(document.createElement("div"));
  cleanup.push(() => ancestor.remove());
  const region = ancestor.appendChild(document.createElement("div"));
  const first = region.appendChild(document.createElement("button"));
  const second = region.appendChild(document.createElement("button"));
  const outside = ancestor.appendChild(document.createElement("button"));
  first.id = "scroll-position-first";
  second.id = "scroll-position-second";
  outside.id = "scroll-position-outside";
  vi.spyOn(region, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 200, 100));
  vi.spyOn(first, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 240, 200, 20));
  vi.spyOn(second, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 80, 200, 20));
  const nativeScroll = vi.spyOn(Element.prototype, "scrollIntoView");
  const [activeId, setActiveId] = createSignal<string | null>(first.id);
  ancestor.scrollTop = 400;
  region.scrollTop = 100;
  region.scrollLeft = 25;
  const stop = createRoot((dispose) => {
    createScrollPosition(
      () => {
        const initialId = activeId();
        return {
          reveal: initialId
            ? { identity: [initialId], target: () => document.getElementById(initialId) }
            : undefined,
        };
      },
      { region: () => region, revealTiming: "animation-frame" },
    );
    return dispose;
  });
  cleanup.push(stop);
  flush();
  expect(region.scrollTop).toBe(100);

  setActiveId(second.id);
  flush();
  expect(region.scrollTop).toBe(100);
  vi.advanceTimersToNextFrame();
  expect(region.scrollTop).toBe(80);

  setActiveId(first.id);
  flush();
  vi.advanceTimersToNextFrame();
  expect(region.scrollTop).toBe(140);

  setActiveId(second.id);
  flush();
  setActiveId(null);
  flush();
  vi.advanceTimersToNextFrame();
  expect(region.scrollTop).toBe(140);

  setActiveId(outside.id);
  flush();
  vi.advanceTimersToNextFrame();
  expect(region.scrollTop).toBe(140);

  setActiveId(second.id);
  flush();
  stop();
  vi.advanceTimersToNextFrame();
  expect(region.scrollTop).toBe(140);
  expect(region.scrollLeft).toBe(25);
  expect(ancestor.scrollTop).toBe(400);
  expect(nativeScroll).not.toHaveBeenCalled();
});

it("keeps untracked scroll state until the next layout observation", () => {
  const element = document.body.appendChild(document.createElement("div"));
  cleanup.push(() => element.remove());
  const values = geometry(element);
  const binding = createRoot((dispose) => ({
    dispose,
    ref: createScrollStateRef(reflect, { trackScroll: false }),
  }));
  cleanup.push(binding.dispose);
  binding.ref(element);
  flush();
  vi.advanceTimersToNextFrame();
  expect(element.dataset).toMatchObject({ scrollable: "true", atEnd: "false" });

  values.offset = 200;
  element.dispatchEvent(new Event("scroll"));
  vi.advanceTimersToNextFrame();
  expect(element.dataset.atEnd).toBe("false");

  observers.at(-1)!.deliver(element);
  vi.advanceTimersToNextFrame();
  expect(element.dataset.atEnd).toBe("true");
});
