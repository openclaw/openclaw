/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeScrollState } from "./scroll-state-observer.ts";

type Publish = Parameters<typeof observeScrollState>[1];
let container: HTMLDivElement;
let resized: (entries: ResizeObserverEntry[]) => void;
const unobserve = vi.fn();
const observations: ReturnType<typeof observeScrollState>[] = [];
const atStart = { scrollable: true, atStart: true, atEnd: false };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = (entries) => callback(entries, this);
      }
      observe = vi.fn();
      unobserve = unobserve;
      disconnect = vi.fn();
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
  resized([
    {
      target: element,
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
      contentRect: new DOMRectReadOnly(),
    },
  ]);
  expect(publish).toHaveBeenLastCalledWith(atStart);
  vi.advanceTimersToNextFrame();
  expect(publish).toHaveBeenLastCalledWith({ scrollable: true, atStart: false, atEnd: true });
  observation.disconnect();
  expect(unobserve).toHaveBeenCalledWith(element);
  element.dispatchEvent(new Event("scroll"));
  vi.advanceTimersToNextFrame();
  expect(publish).toHaveBeenCalledTimes(2);
});
