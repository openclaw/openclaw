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

function geometry(element: HTMLElement, reads: string[], name: string) {
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
}

describe("scroll state observation", () => {
  it("batches every scroller read before publishing", () => {
    const elements = [document.createElement("div"), document.createElement("div")];
    container.append(...elements);
    const order: string[] = [];
    const publishers = elements.map((element, index) => {
      geometry(element, order, `read-${index}`);
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
      expect(publish).toHaveBeenCalledExactlyOnceWith({
        scrollable: true,
        atStart: true,
        atEnd: false,
      });
    }
    order.length = 0;
    elements[0]!.dispatchEvent(new Event("scroll"));
    elements[0]!.dispatchEvent(new Event("scroll"));
    expect(order).toEqual([]);
    vi.advanceTimersToNextFrame();
    expect(order).toEqual(["read-0", "publish-0"]);
  });

  it("updates scroll boundaries after resize and stops observing after disconnect", () => {
    const element = document.createElement("div");
    container.append(element);
    geometry(element, [], "read");
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
    expect(publish).toHaveBeenLastCalledWith({ scrollable: true, atStart: true, atEnd: false });
    vi.advanceTimersToNextFrame();
    expect(publish).toHaveBeenLastCalledWith({ scrollable: true, atStart: false, atEnd: true });
    observation.disconnect();
    expect(unobserve).toHaveBeenCalledWith(element);
    element.dispatchEvent(new Event("scroll"));
    vi.advanceTimersToNextFrame();
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("shares geometry reads between observers of the same scroller", () => {
    const element = document.createElement("div");
    container.append(element);
    const reads: string[] = [];
    geometry(element, reads, "read");
    const publishers = [vi.fn(), vi.fn()];
    const observers = publishers.map((publish) => watch(element, publish));
    for (const observation of observers) {
      observation.schedule();
    }
    expect(reads).toEqual([]);
    vi.advanceTimersToNextFrame();
    expect(reads).toEqual(["read"]);
    for (const publish of publishers) {
      expect(publish).toHaveBeenCalledExactlyOnceWith({
        scrollable: true,
        atStart: true,
        atEnd: false,
      });
    }
  });
});
