/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeScrollState } from "./scroll-state-observer.ts";

type Publish = Parameters<typeof observeScrollState>[1];

let container: HTMLDivElement;
let resized: (entries: ResizeObserverEntry[]) => void;
const unobserve = vi.fn();
const observations: ReturnType<typeof observeScrollState>[] = [];

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
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  for (const observation of observations.splice(0)) {
    observation.disconnect();
  }
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
  Object.defineProperties(element, {
    scrollHeight: {
      configurable: true,
      get: () => {
        reads.push(name);
        return 200;
      },
    },
    clientHeight: { configurable: true, value: 100 },
  });
  return element;
}

const atStart = { scrollable: true, atStart: true, atEnd: false };

describe("scroll state observation", () => {
  it("batches every scroller read before publishing", () => {
    const order: string[] = [];
    const elements = [scroller(order, "read-0"), scroller(order, "read-1")];
    const publishers = elements.map((element, index) => {
      const publish = vi.fn<Publish>(() => {
        order.push(`publish-${index}`);
      });
      watch(element, publish);
      return publish;
    });
    expect(order).toEqual([]);
    vi.advanceTimersToNextFrame();
    expect(order).toEqual(["read-0", "read-1", "publish-0", "publish-1"]);
    for (const publish of publishers) {
      expect(publish).toHaveBeenCalledExactlyOnceWith(atStart);
    }
    order.length = 0;
    elements[0]!.dispatchEvent(new Event("scroll"));
    elements[0]!.dispatchEvent(new Event("scroll"));
    expect(order).toEqual([]);
    vi.advanceTimersToNextFrame();
    expect(order).toEqual(["read-0", "publish-0"]);
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

  it("shares geometry reads between observers of the same scroller", () => {
    const reads: string[] = [];
    const element = scroller(reads);
    const publishers = [vi.fn(), vi.fn()];
    const observers = publishers.map((publish) => watch(element, publish));
    for (const observation of observers) {
      observation.schedule();
    }
    expect(reads).toEqual([]);
    vi.advanceTimersToNextFrame();
    expect(reads).toEqual(["read"]);
    for (const publish of publishers) {
      expect(publish).toHaveBeenCalledExactlyOnceWith(atStart);
    }
  });
});
