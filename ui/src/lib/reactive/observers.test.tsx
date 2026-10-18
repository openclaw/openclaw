import { createRoot, createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createIntersectionObserver, createResizeObserver } from "./observers.ts";

afterEach(() => vi.unstubAllGlobals());

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
