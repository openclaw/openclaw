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
    const entry: ResizeObserverEntry = {
      target: element,
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
      contentRect: new DOMRectReadOnly(),
    };
    this.callback([entry], this);
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

function expectFrame(element: HTMLElement, scrollable: boolean, atEnd: boolean, atStart?: boolean) {
  flush();
  vi.advanceTimersToNextFrame();
  expect(element.dataset).toMatchObject({ scrollable: String(scrollable), atEnd: String(atEnd) });
  if (atStart !== undefined) {
    expect(element.dataset.atStart).toBe(String(atStart));
  }
}

function externalScroll(
  options: Parameters<typeof createScrollStateRef>[1] = {},
  publish = reflect,
) {
  const element = document.body.appendChild(document.createElement("div"));
  cleanup.push(() => element.remove());
  const values = geometry(element, options.horizontal);
  const binding = createRoot((dispose) => ({
    dispose,
    ref: createScrollStateRef(publish, options),
  }));
  cleanup.push(binding.dispose);
  binding.ref(element);
  return { element, values, dispose: binding.dispose };
}

it("keeps horizontal scroll affordances on Solid-bound elements", () => {
  const view = mountSolid(() => <div role="region" ref={useScrollState(true)} />);
  cleanup.push(view.unmount);
  const element = view.getByRole("region");
  const values = geometry(element, true);
  expectFrame(element, true, false, true);
  values.offset = 200;
  element.dispatchEvent(new Event("scroll"));
  expectFrame(element, true, true, false);
});

it("moves observation to the rendered replacement and ignores the old pending layout", () => {
  const [identity, setIdentity] = createSignal(0);
  const view = mountSolid(() => {
    const ref = createScrollStateRef(reflect);
    return <For each={[identity()]}>{() => <div role="region" ref={ref} />}</For>;
  });
  cleanup.push(view.unmount);
  const first = view.getByRole("region");
  const firstGeometry = geometry(first);
  expectFrame(first, true, false);
  const oldObserver = observers.at(-1)!;

  firstGeometry.offset = 200;
  first.dispatchEvent(new Event("scroll"));
  setIdentity(1);
  flush();
  const second = view.getByRole("region");
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
  const publish = vi.fn(reflect);
  const [presented, setPresented] = createSignal(true);
  const [content, setContent] = createSignal("long path");
  const { element, values, dispose } = externalScroll(
    { presented, content, horizontal: true },
    publish,
  );
  expectFrame(element, true, false);
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
  expectFrame(element, false, true);
  publish.mockClear();
  values.extent = 400;
  setContent("a longer path");
  expectFrame(element, true, false);
  expect(publish).toHaveBeenCalledExactlyOnceWith(element, {
    scrollable: true,
    atStart: true,
    atEnd: false,
  });
  expect(observers.filter((observer) => observer.targets.has(element))).toHaveLength(1);

  values.offset = 300;
  element.dispatchEvent(new Event("scroll"));
  const retiringObserver = observers.at(-1)!;
  dispose();
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
  vi.spyOn(region, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 100, 200, 100));
  vi.spyOn(first, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 240, 200, 20));
  vi.spyOn(second, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 80, 200, 20));
  const nativeScroll = vi.spyOn(Element.prototype, "scrollIntoView");
  const [active, setActive] = createSignal<HTMLElement | null>(first);
  const select = (target: HTMLElement | null) => {
    setActive(target);
    flush();
  };
  ancestor.scrollTop = 400;
  Object.assign(region, { scrollTop: 100, scrollLeft: 25 });
  const stop = createRoot((dispose) => {
    createScrollPosition(
      () => {
        const initialTarget = active();
        return {
          reveal: initialTarget
            ? { identity: [initialTarget], target: () => initialTarget }
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

  select(second);
  expect(region.scrollTop).toBe(100);
  vi.advanceTimersToNextFrame();
  expect(region.scrollTop).toBe(80);

  select(first);
  vi.advanceTimersToNextFrame();
  expect(region.scrollTop).toBe(140);

  select(second);
  select(null);
  vi.advanceTimersToNextFrame();
  expect(region.scrollTop).toBe(140);

  select(outside);
  vi.advanceTimersToNextFrame();
  expect(region.scrollTop).toBe(140);

  select(second);
  stop();
  vi.advanceTimersToNextFrame();
  expect(region.scrollTop).toBe(140);
  expect(region.scrollLeft).toBe(25);
  expect(ancestor.scrollTop).toBe(400);
  expect(nativeScroll).not.toHaveBeenCalled();
});

it("keeps untracked scroll state until the next layout observation", () => {
  const { element, values } = externalScroll({ trackScroll: false });
  expectFrame(element, true, false);

  values.offset = 200;
  element.dispatchEvent(new Event("scroll"));
  vi.advanceTimersToNextFrame();
  expect(element.dataset.atEnd).toBe("false");

  observers.at(-1)!.deliver(element);
  vi.advanceTimersToNextFrame();
  expect(element.dataset.atEnd).toBe("true");
});

it("resamples loaded font metrics only for the current presented element", async () => {
  let fontsReady!: () => void;
  const fonts = new EventTarget();
  Object.defineProperty(fonts, "ready", {
    value: new Promise<void>((resolve) => {
      fontsReady = resolve;
    }),
  });
  const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  cleanup.push(() => {
    if (originalFonts) {
      Object.defineProperty(document, "fonts", originalFonts);
    }
  });
  const first = document.body.appendChild(document.createElement("div"));
  const second = document.body.appendChild(document.createElement("div"));
  cleanup.push(
    () => first.remove(),
    () => second.remove(),
  );
  const firstGeometry = geometry(first, true);
  const secondGeometry = geometry(second, true);
  const [presented, setPresented] = createSignal(true);
  const publish = vi.fn(reflect);
  const binding = createRoot((dispose) => ({
    dispose,
    ref: createScrollStateRef(publish, { horizontal: true, trackScroll: false, presented }),
  }));
  cleanup.push(binding.dispose);
  binding.ref(first);
  flush();
  vi.advanceTimersToNextFrame();
  expect(first.dataset.scrollable).toBe("true");

  binding.ref(second);
  flush();
  vi.advanceTimersToNextFrame();
  firstGeometry.extent = 50;
  secondGeometry.extent = 50;
  fontsReady();
  await Promise.resolve();
  vi.advanceTimersToNextFrame();
  expect(first.dataset.scrollable).toBe("true");
  expect(second.dataset.scrollable).toBe("false");

  setPresented(false);
  flush();
  secondGeometry.extent = 300;
  fonts.dispatchEvent(new Event("loadingdone"));
  vi.advanceTimersToNextFrame();
  expect(second.dataset.scrollable).toBe("false");

  setPresented(true);
  flush();
  await Promise.resolve();
  vi.advanceTimersToNextFrame();
  expect(second.dataset.scrollable).toBe("true");
  secondGeometry.extent = 50;
  fonts.dispatchEvent(new Event("loadingdone"));
  fonts.dispatchEvent(new Event("loadingdone"));
  publish.mockClear();
  vi.advanceTimersToNextFrame();
  expect(second.dataset.scrollable).toBe("false");
  expect(publish).toHaveBeenCalledTimes(1);

  binding.dispose();
  publish.mockClear();
  secondGeometry.extent = 300;
  fonts.dispatchEvent(new Event("loadingdone"));
  vi.advanceTimersToNextFrame();
  expect(publish).not.toHaveBeenCalled();
});

it("restores a destination after readiness without overwriting subsequent reader scroll", () => {
  const outer = document.body.appendChild(document.createElement("div"));
  const element = outer.appendChild(document.createElement("div"));
  cleanup.push(() => outer.remove());
  Object.defineProperty(element, "scrollWidth", { value: 700 });
  outer.scrollTop = 400;
  const [target, setTarget] = createSignal<HTMLElement>();
  const [ready, setReady] = createSignal(false);
  const [destination, setDestination] = createSignal("root");
  const [savedTop, setSavedTop] = createSignal(37);
  const stop = createRoot((dispose) => {
    createScrollPosition(() => {
      const currentTarget = target();
      return {
        restore: ready()
          ? {
              identity: [destination(), currentTarget],
              target: currentTarget,
              top: savedTop(),
              left: "end",
            }
          : undefined,
      };
    });
    return dispose;
  });
  cleanup.push(stop);
  setReady(true);
  flush();
  setTarget(element);
  flush();
  expect(element.scrollTop).toBe(37);
  expect(element.scrollLeft).toBe(700);

  element.scrollTop = 91;
  setSavedTop(91);
  flush();
  expect(element.scrollTop).toBe(91);
  setSavedTop(37);
  flush();
  expect(element.scrollTop).toBe(91);

  setReady(false);
  flush();
  setDestination("folder");
  setSavedTop(12);
  flush();
  expect(element.scrollTop).toBe(91);
  setReady(true);
  flush();
  expect(element.scrollTop).toBe(12);
  expect(outer.scrollTop).toBe(400);
});
