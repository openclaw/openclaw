import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { restorePropertyDescriptor } from "../../test-helpers/property-descriptor.ts";
import { createLayoutMeasurement } from "./layout-measurement.ts";

const cleanup: Array<() => void> = [];
let resize: () => void;
let disconnected = false;

it.each([false, true])("remeasures when fonts settle unless disposed: %s", (disposed) => {
  const fonts = Object.assign(new EventTarget(), { ready: new Promise(() => {}) });
  const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  onTestFinished(() => {
    restorePropertyDescriptor(document, "fonts", previousFonts);
  });
  let element!: HTMLDivElement;
  let width = 10;
  const reads: number[] = [];
  const view = mountSolid(() => {
    createLayoutMeasurement(
      () => true,
      () => {
        const measuredWidth = width;
        reads.push(measuredWidth);
        return () => {
          element.style.width = measuredWidth + "px";
        };
      },
      { targets: () => [element], fonts: true },
    );
    return <div ref={(node) => (element = node)} />;
  });
  cleanup.push(view.unmount);
  flush();
  vi.advanceTimersToNextFrame();
  expect(element.style.width).toBe("10px");
  width = 20;
  if (disposed) {
    view.unmount();
  }
  fonts.dispatchEvent(new Event("loadingdone"));
  vi.advanceTimersToNextFrame();
  expect(reads).toEqual(disposed ? [10] : [10, 20]);
  expect(element.style.width).toBe(disposed ? "10px" : "20px");
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  disconnected = false;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {
        disconnected = true;
      }
    },
  );
});
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
    const reads: number[] = [];
    let element!: HTMLDivElement;
    let requestMeasurement!: () => void;
    const view = mountSolid(() => {
      requestMeasurement = createLayoutMeasurement(
        () => ({ width: width() }),
        (snapshot) => {
          if (!snapshot) {
            return undefined;
          }
          reads.push(snapshot.width);
          return () => {
            element.style.width = snapshot.width + "px";
          };
        },
        { targets: () => [element], changeTiming },
      );
      return (
        <div
          ref={(node) => {
            element = node;
          }}
        />
      );
    });
    cleanup.push(view.unmount);
    flush();
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
    requestMeasurement();
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
