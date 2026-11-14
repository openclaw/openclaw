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

function mockObserver(name = "ResizeObserver") {
  const instances: Observer[] = [];
  class Observer {
    readonly targets = new Set<Element>();
    constructor(readonly deliver: ResizeObserverCallback) {
      instances.push(this);
    }
    observe = (target: Element) => this.targets.add(target);
    unobserve = (target: Element) => this.targets.delete(target);
    disconnect = () => this.targets.clear();
  }
  vi.stubGlobal(name, Observer);
  return instances;
}

it.each([
  { name: "ResizeObserver", create: createResizeObserver },
  { name: "IntersectionObserver", create: createIntersectionObserver },
])("waits for refs, rebinds $name targets and disconnects with the owner", ({ name, create }) => {
  const instances = mockObserver(name);
  let first!: HTMLDivElement;
  const second = document.createElement("div");
  const [targets, setTargets] = createSignal<readonly Element[]>();
  const view = mountSolid(() => {
    create(
      () => targets() ?? [first.closest("section") ?? first, second],
      () => {},
    );
    return <div ref={(node) => (first = node)} />;
  });
  flush();
  expect(instances[0]?.targets).toEqual(new Set([first, second]));
  setTargets([second]);
  flush();
  expect(instances[0]?.targets.size).toBe(0);
  expect(instances[1]?.targets).toEqual(new Set([second]));
  view.unmount();
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

it("shares resize delivery without mixing subscribers or retaining retired targets", async () => {
  const instances = mockObserver();
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
  expect(instances).toHaveLength(1);
  const observer = instances[0]!;
  observer.deliver([resizeEntry(first), resizeEntry(second)], observer);
  expect(batches).toEqual([[first, second]]);
  expect(secondCallback).not.toHaveBeenCalled();
  expect(observer.targets).toEqual(new Set([first, second]));
  const lateCallback = vi.fn();
  const releaseLate = observeResize([second], lateCallback);
  onTestFinished(releaseLate);
  await Promise.resolve();
  expect(lateCallback.mock.calls[0]?.[0].map((entry: ResizeObserverEntry) => entry.target)).toEqual(
    [second],
  );
  releaseFirst();
  expect(observer.targets).toEqual(new Set([second]));
  releaseLate();
  expect(observer.targets.size).toBe(0);
});

it("reports subscriber errors without starving independent observation", () => {
  const instances = mockObserver();
  const report = vi.fn();
  vi.stubGlobal("reportError", report);
  const target = document.createElement("div");
  const failure = new Error("Observer callback failed");
  onTestFinished(
    observeResize([target], () => {
      throw failure;
    }),
  );
  const receive = vi.fn();
  onTestFinished(observeResize([target], receive));
  const observer = instances[0]!;
  observer.deliver([resizeEntry(target)], observer);
  expect(report).toHaveBeenCalledExactlyOnceWith(failure);
  expect(receive).toHaveBeenCalledOnce();
});
