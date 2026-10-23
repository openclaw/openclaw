/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { collectGarbageForTest } from "../test-helpers/garbage-collection.ts";
import { observeScrollState } from "./scroll-state-observer.ts";

type Publish = Parameters<typeof observeScrollState>[1];
let container: HTMLDivElement;
let resized: (entries: Pick<ResizeObserverEntry, "target">[]) => void;
const unobserve = vi.fn();
const observations: ReturnType<typeof observeScrollState>[] = [];
const atStart = { scrollable: true, atStart: true, atEnd: false };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: typeof resized) {
        resized = callback;
      }
      observe = vi.fn();
      unobserve = unobserve;
      disconnect() {
        resized = () => {};
      }
    },
  );
  container = document.body.appendChild(document.createElement("div"));
});
afterEach(() => {
  observations.splice(0).forEach((observation) => observation.disconnect());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function watch(element: HTMLElement, publish: Publish) {
  const observation = observeScrollState(element, publish);
  observations.push(observation);
  return observation;
}
function scroller(reads: string[] = [], name = "read") {
  const element = container.appendChild(document.createElement("div"));
  vi.spyOn(element, "scrollHeight", "get").mockImplementation(() => {
    reads.push(name);
    return 200;
  });
  vi.spyOn(element, "clientHeight", "get").mockReturnValue(100);
  return element;
}

it.each([false, true])("batches geometry and scrolls (shared=%s)", (shared) => {
  const order: string[] = [];
  const first = scroller(order, "read-0");
  const elements = [first, shared ? first : scroller(order, "read-1")];
  const publishers = elements.map((element, index) => {
    const publish = vi.fn<Publish>(() => {
      order.push(`publish-${index}`);
    });
    watch(element, publish);
    return publish;
  });
  if (shared) {
    observations.forEach((observation) => observation.schedule());
  }
  expect(order).toEqual([]);
  vi.advanceTimersToNextFrame();
  expect(order).toEqual(
    shared ? ["read-0", "publish-0", "publish-1"] : ["read-0", "read-1", "publish-0", "publish-1"],
  );
  publishers.forEach((publish) => expect(publish).toHaveBeenCalledExactlyOnceWith(atStart));
  order.length = 0;
  first.dispatchEvent(new Event("scroll"));
  first.dispatchEvent(new Event("scroll"));
  expect(order).toEqual([]);
  vi.advanceTimersToNextFrame();
  expect(order).toEqual(shared ? ["read-0", "publish-0", "publish-1"] : ["read-0", "publish-0"]);
});

it("updates scroll boundaries after resize and stops observing after disconnect", () => {
  const element = scroller();
  const publish = vi.fn();
  const observation = watch(element, publish);
  vi.advanceTimersToNextFrame();
  element.scrollTop = 100;
  resized([{ target: element }]);
  expect(publish).toHaveBeenLastCalledWith(atStart);
  vi.advanceTimersToNextFrame();
  expect(publish).toHaveBeenLastCalledWith({ scrollable: true, atStart: false, atEnd: true });
  observation.disconnect();
  expect(unobserve).toHaveBeenCalledWith(element);
  element.dispatchEvent(new Event("scroll"));
  vi.advanceTimersToNextFrame();
  expect(publish).toHaveBeenCalledTimes(2);
});

it("releases retired publishers while fonts load and remeasures active views", async () => {
  const fonts = Object.assign(new EventTarget(), { ready: new Promise(() => {}) });
  const previous = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  onTestFinished(() => {
    if (previous) {
      Object.defineProperty(document, "fonts", previous);
    } else {
      Reflect.deleteProperty(document, "fonts");
    }
  });
  function retire() {
    const payload: { lastState?: Parameters<Publish>[0] } = {};
    const observation = observeScrollState(document.createElement("div"), (state) => {
      payload.lastState = state;
    });
    observation.disconnect();
    return new WeakRef(payload);
  }
  const retired = retire();
  const control = new WeakRef({ unowned: true });
  await collectGarbageForTest();
  expect(control.deref()).toBeUndefined();
  expect(retired.deref()).toBeUndefined();

  const template = document.createElement("template");
  const element = template.content.appendChild(document.createElement("div"));
  Object.defineProperties(element, {
    scrollHeight: { value: 200 },
    clientHeight: { value: 100 },
  });
  const publish = vi.fn();
  const observation = watch(element, publish);
  container.appendChild(element);
  vi.advanceTimersToNextFrame();
  element.scrollTop = 100;
  fonts.dispatchEvent(new Event("loadingdone"));
  vi.advanceTimersToNextFrame();
  expect(publish).toHaveBeenLastCalledWith({ scrollable: true, atStart: false, atEnd: true });
  observation.disconnect();
  fonts.dispatchEvent(new Event("loadingdone"));
  vi.advanceTimersToNextFrame();
  expect(publish).toHaveBeenCalledTimes(2);
});
