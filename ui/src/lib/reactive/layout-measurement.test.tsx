import { Show, createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { observeScrollState } from "../../components/scroll-state-observer.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import { observeFontLoading } from "./font-loading.ts";
import { createLayoutMeasurement } from "./layout-measurement.ts";

const cleanup: Array<() => void> = [];
let resize: (target?: Element) => void;
let disconnected = false;

function mockFonts(fonts = new EventTarget()) {
  const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  onTestFinished(() => restorePropertyDescriptor(document, "fonts", previousFonts));
  return fonts;
}

function mountWidthMeasurement(
  width: () => number,
  options: Omit<Parameters<typeof createLayoutMeasurement>[2], "targets"> = {},
  sample: "snapshot" | "live" = "snapshot",
) {
  let element!: HTMLDivElement;
  let request!: () => void;
  const reads: number[] = [];
  const measure = vi.fn((snapshot: { width: number } | undefined) => {
    if (!snapshot) {
      return undefined;
    }
    const measuredWidth = sample === "live" ? width() : snapshot.width;
    reads.push(measuredWidth);
    return () => {
      element.style.width = measuredWidth + "px";
    };
  });
  const view = mountSolid(() => {
    request = createLayoutMeasurement(() => ({ width: width() }), measure, {
      ...options,
      targets: () => [element],
    });
    return <div ref={(node) => (element = node)} />;
  });
  cleanup.push(view.unmount);
  flush();
  return { ...view, element, request, reads, measure };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  disconnected = false;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        resize = (target) =>
          callback(
            (target ? [target] : [...this.targets]).map((element) => ({
              target: element,
              contentRect: new DOMRectReadOnly(),
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            })),
            this,
          );
      }
      observe(target: Element) {
        this.targets.add(target);
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        disconnected = true;
        this.targets.clear();
      }
    },
  );
});

it("stops retired layout targets while the replacement keeps measuring", () => {
  const first = document.createElement("div");
  const second = document.createElement("div");
  const [target, setTarget] = createSignal(first);
  const reads: Element[] = [];
  const view = mountSolid(() => {
    createLayoutMeasurement(
      target,
      (element) => {
        if (element) {
          reads.push(element);
        }
      },
      { targets: (element) => (element ? [element] : []), changeTiming: "sync" },
    );
    return <>{[first, second]}</>;
  });
  cleanup.push(view.unmount);
  flush();
  expect(reads).toEqual([first]);
  setTarget(second);
  flush();
  expect(reads).toEqual([first, second]);
  resize(first);
  vi.advanceTimersToNextFrame();
  expect(reads).toEqual([first, second]);
  resize(second);
  vi.advanceTimersToNextFrame();
  expect(reads).toEqual([first, second, second]);
  view.unmount();
  resize(second);
  vi.advanceTimersToNextFrame();
  expect(reads).toEqual([first, second, second]);
});
it.each([false, true])(
  "retires a detached conditional target before empty layout (measureWithoutTarget=%s)",
  (measureWithoutTarget) => {
    const observe = vi.spyOn(ResizeObserver.prototype, "observe");
    const unobserve = vi.spyOn(ResizeObserver.prototype, "unobserve");
    const [visible, setVisible] = createSignal(true);
    const reads: Array<boolean | undefined> = [];
    const writes: Array<boolean | undefined> = [];
    let element!: HTMLDivElement;
    const view = mountSolid(() => {
      createLayoutMeasurement(
        visible,
        (shown) => {
          reads.push(shown);
          return () => writes.push(shown);
        },
        { targets: () => [element], measureWithoutTarget },
      );
      return (
        <Show when={visible()}>
          <div ref={(node) => (element = node)} />
        </Show>
      );
    });
    cleanup.push(view.unmount);
    flush();
    vi.advanceTimersToNextFrame();
    const first = element;
    expect(observe).toHaveBeenCalledWith(first, { box: "content-box" });
    expect(reads).toEqual([true]);
    expect(writes).toEqual([true]);

    setVisible(false);
    flush();
    expect(first.isConnected).toBe(false);
    vi.advanceTimersToNextFrame();
    expect(unobserve).toHaveBeenCalledWith(first);
    expect(disconnected).toBe(true);
    expect(reads).toEqual(measureWithoutTarget ? [true, false] : [true]);
    expect(writes).toEqual(reads);

    setVisible(true);
    flush();
    vi.advanceTimersToNextFrame();
    expect(element).not.toBe(first);
    expect(observe).toHaveBeenLastCalledWith(element, { box: "content-box" });
    expect(reads).toEqual(measureWithoutTarget ? [true, false, true] : [true, true]);
    expect(writes).toEqual(reads);
  },
);

afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose();
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([undefined, "sync"] as const)(
  "keeps %s change timing, current snapshots, and frame-batched resize",
  (changeTiming) => {
    const [width, setWidth] = createSignal(10);
    const view = mountWidthMeasurement(width, { changeTiming });
    const { element, reads } = view;
    expect(element.style.width).toBe(changeTiming === "sync" ? "10px" : "");
    vi.advanceTimersToNextFrame();
    expect(element.style.width).toBe("10px");

    setWidth(20);
    flush();
    expect(element.style.width).toBe(changeTiming === "sync" ? "20px" : "10px");
    setWidth(30);
    flush();
    vi.advanceTimersToNextFrame();
    expect(element.style.width).toBe("30px");
    expect(reads).toEqual(changeTiming === "sync" ? [10, 20, 30] : [10, 30]);

    element.style.width = "5px";
    resize();
    view.request();
    expect(element.style.width).toBe("5px");
    vi.advanceTimersToNextFrame();
    expect(element.style.width).toBe("30px");
    expect(reads.at(-1)).toBe(30);

    resize();
    const count = reads.length;
    view.unmount();
    expect(disconnected).toBe(true);
    vi.advanceTimersToNextFrame();
    resize();
    vi.advanceTimersToNextFrame();
    expect(reads).toHaveLength(count);
  },
);

it("shares font delivery across measurement and scroll owners without crossing font sets", () => {
  const firstFonts = new EventTarget();
  const secondFonts = new EventTarget();
  const subscribe = vi.spyOn(firstFonts, "addEventListener");
  const unsubscribe = vi.spyOn(firstFonts, "removeEventListener");
  mockFonts(firstFonts);
  const setFonts = (fonts: EventTarget) =>
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  const widths = { current: 10 };
  const measurement = () => mountWidthMeasurement(() => widths.current, { fonts: true }, "live");
  const first = measurement();
  const second = measurement();
  const scroll = document.body.appendChild(document.createElement("div"));
  cleanup.push(() => scroll.remove());
  const scrollGeometry = { width: 200 };
  Object.defineProperties(scroll, {
    scrollWidth: { get: () => scrollGeometry.width },
    clientWidth: { value: 100 },
  });
  const publish = vi.fn();
  const observation = observeScrollState(scroll, publish, true, false);
  cleanup.push(observation.disconnect);
  setFonts(secondFonts);
  const other = measurement();
  vi.advanceTimersToNextFrame();
  expect(subscribe).toHaveBeenCalledOnce();
  widths.current = 20;
  scrollGeometry.width = 50;
  firstFonts.dispatchEvent(new Event("loadingdone"));
  vi.advanceTimersToNextFrame();
  expect([
    first.element.style.width,
    second.element.style.width,
    other.element.style.width,
  ]).toEqual(["20px", "20px", "10px"]);
  expect(publish).toHaveBeenLastCalledWith({ scrollable: false, atStart: true, atEnd: true });
  first.unmount();
  first.measure.mockClear();
  second.measure.mockClear();
  widths.current = 30;
  firstFonts.dispatchEvent(new Event("loadingdone"));
  vi.advanceTimersToNextFrame();
  expect(first.element.style.width).toBe("20px");
  expect(first.measure).not.toHaveBeenCalled();
  expect(second.element.style.width).toBe("30px");
  expect(second.measure).toHaveBeenCalledOnce();
  expect(unsubscribe).not.toHaveBeenCalled();
  second.unmount();
  observation.disconnect();
  expect(unsubscribe).toHaveBeenCalledOnce();
  secondFonts.dispatchEvent(new Event("loadingdone"));
  vi.advanceTimersToNextFrame();
  expect(other.element.style.width).toBe("30px");
  setFonts(firstFonts);
  const replacement = measurement();
  vi.advanceTimersToNextFrame();
  expect(replacement.element.style.width).toBe("30px");
  expect(subscribe).toHaveBeenCalledTimes(2);
});

it("retains duplicate font callbacks independently and skips only retired listeners", () => {
  const fonts = mockFonts();
  const callback = vi.fn();
  const first = observeFontLoading(document.fonts, callback);
  const second = observeFontLoading(document.fonts, callback);
  cleanup.push(first, second);
  fonts.dispatchEvent(new Event("loadingdone"));
  expect(callback).toHaveBeenCalledTimes(2);
  first();
  callback.mockClear();
  fonts.dispatchEvent(new Event("loadingdone"));
  expect(callback).toHaveBeenCalledOnce();
  second();

  const retiring = vi.fn();
  let stopRetiring = () => {};
  const stopFirst = observeFontLoading(document.fonts, () => stopRetiring());
  stopRetiring = observeFontLoading(document.fonts, retiring);
  const stopLast = observeFontLoading(document.fonts, callback);
  cleanup.push(stopFirst, stopRetiring, stopLast);
  callback.mockClear();
  fonts.dispatchEvent(new Event("loadingdone"));
  expect(retiring).not.toHaveBeenCalled();
  expect(callback).toHaveBeenCalledOnce();
});

it("reports a failed font subscriber without starving later measurements", () => {
  const fonts = mockFonts();
  const report = vi.fn();
  vi.stubGlobal("reportError", report);
  const error = new Error("font subscriber failed");
  const stopFailure = observeFontLoading(document.fonts, () => {
    throw error;
  });
  const measured = vi.fn();
  const stopMeasured = observeFontLoading(document.fonts, measured);
  cleanup.push(stopFailure, stopMeasured);
  fonts.dispatchEvent(new Event("loadingdone"));
  expect(report).toHaveBeenCalledExactlyOnceWith(error);
  expect(measured).toHaveBeenCalledOnce();
  stopFailure();
  fonts.dispatchEvent(new Event("loadingdone"));
  expect(report).toHaveBeenCalledOnce();
  expect(measured).toHaveBeenCalledTimes(2);
});
