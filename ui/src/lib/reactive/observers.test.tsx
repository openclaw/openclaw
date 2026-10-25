import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createIntersectionObserver, createResizeObserver, observeResize } from "./observers.ts";

afterEach(() => vi.unstubAllGlobals());

function resizeEntry(target: Element): ResizeObserverEntry {
  return {
    target,
    contentRect: new DOMRectReadOnly(),
    borderBoxSize: [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
}

it.each([
  { name: "ResizeObserver", create: createResizeObserver },
  { name: "IntersectionObserver", create: createIntersectionObserver },
])("rebinds $name targets and disconnects with the owner", ({ name, create }) => {
  const instances: Array<{ targets: Set<Element> }> = [];
  vi.stubGlobal(
    name,
    class {
      targets = new Set<Element>();
      constructor() {
        instances.push(this);
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
    },
  );
  const first = document.createElement("div");
  const second = document.createElement("div");
  const [targets, setTargets] = createSignal<readonly Element[]>([first, second]);
  const dispose = createRoot((stop) => {
    create(targets, () => {});
    return stop;
  });
  onTestFinished(dispose);
  flush();
  expect(instances[0]?.targets).toEqual(new Set([first, second]));
  setTargets([second]);
  flush();
  expect(instances[0]?.targets.size).toBe(0);
  expect(instances[1]?.targets).toEqual(new Set([second]));
  dispose();
  expect(instances[1]?.targets.size).toBe(0);
});

it("does not require browser observers when they are unavailable", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("IntersectionObserver", undefined);
  const dispose = createRoot((stop) => {
    const targets = () => [document.body];
    createResizeObserver(targets, () => {});
    createIntersectionObserver(targets, () => {});
    return stop;
  });
  onTestFinished(dispose);
  expect(() => flush()).not.toThrow();
});

it("waits for rendered refs before reading observer targets", () => {
  const targets = new Set<Element>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(target: Element) {
        targets.add(target);
      }
      unobserve(target: Element) {
        targets.delete(target);
      }
      disconnect() {
        targets.clear();
      }
    },
  );
  const view = mountSolid(() => {
    let element!: HTMLDivElement;
    createResizeObserver(
      () => [element.closest("section") ?? element],
      () => {},
    );
    return (
      <div
        ref={(node) => {
          element = node;
        }}
      />
    );
  });
  flush();
  expect(targets).toEqual(new Set([view.container.firstElementChild]));
  view.unmount();
  expect(targets.size).toBe(0);
});

it("shares resize delivery without mixing subscribers or retaining retired targets", async () => {
  let deliver!: ResizeObserverCallback;
  const nativeObservers: ResizeObserver[] = [];
  const observed = new Set<Element>();
  const create = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        create();
        deliver = callback;
        nativeObservers.push(this);
      }
      observe(target: Element) {
        observed.add(target);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
  const first = document.createElement("div");
  const second = document.createElement("div");
  const batches: Element[][] = [];
  let releaseSecond = () => {};
  const releaseFirst = observeResize([first, second], (entries) => {
    batches.push(entries.map((entry) => entry.target));
    releaseSecond();
  });
  const secondCallback = vi.fn();
  releaseSecond = observeResize([second], secondCallback);
  onTestFinished(releaseFirst);
  onTestFinished(releaseSecond);
  expect(create).toHaveBeenCalledOnce();
  deliver([resizeEntry(first), resizeEntry(second)], nativeObservers[0]!);
  expect(batches).toEqual([[first, second]]);
  expect(secondCallback).not.toHaveBeenCalled();
  expect(observed).toEqual(new Set([first, second]));
  const lateCallback = vi.fn();
  const releaseLate = observeResize([second], lateCallback);
  onTestFinished(releaseLate);
  await Promise.resolve();
  expect(lateCallback.mock.calls[0]?.[0].map((entry: ResizeObserverEntry) => entry.target)).toEqual(
    [second],
  );
  releaseFirst();
  expect(observed).toEqual(new Set([second]));
  releaseLate();
  expect(observed.size).toBe(0);
});

it("reports subscriber errors without starving independent observation", () => {
  let deliver!: ResizeObserverCallback;
  const nativeObservers: ResizeObserver[] = [];
  const report = vi.fn();
  vi.stubGlobal("reportError", report);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        deliver = callback;
        nativeObservers.push(this);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const target = document.createElement("div");
  const failure = new Error("Observer callback failed");
  onTestFinished(
    observeResize([target], () => {
      throw failure;
    }),
  );
  const receive = vi.fn();
  onTestFinished(observeResize([target], receive));
  deliver([resizeEntry(target)], nativeObservers[0]!);
  expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  expect(receive).toHaveBeenCalledOnce();
});
