/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrameClock } from "../test-helpers/animation-frame-clock.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import type { MarqueeOptions } from "./hover-marquee.ts";
import { HoverMarquee } from "./solid/hover-marquee.tsx";

function measurementClock() {
  const framesClock = createFrameClock();

  const observers = new Set<ControlledResizeObserver>();
  const visibilityObservers = new Set<ControlledIntersectionObserver>();
  const motion = Object.assign(new EventTarget(), { matches: false });
  class ControlledResizeObserver implements ResizeObserver {
    readonly targets = new Set<Element>();
    constructor(readonly callback: ResizeObserverCallback) {
      observers.add(this);
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
  }
  class ControlledIntersectionObserver {
    readonly targets = new Set<Element>();
    constructor(
      readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void,
    ) {
      visibilityObservers.add(this);
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
  }
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  vi.stubGlobal("requestAnimationFrame", framesClock.request);
  vi.stubGlobal("cancelAnimationFrame", framesClock.cancel);
  vi.stubGlobal("IntersectionObserver", ControlledIntersectionObserver);
  vi.stubGlobal("matchMedia", () => motion);
  const flushFrames = () => {
    framesClock.flush(0);
  };
  return {
    motion,
    async settle() {
      await Promise.resolve();
      flushFrames();
    },
    visible(isIntersecting: boolean, target?: Element) {
      for (const observer of visibilityObservers) {
        if (target ? observer.targets.has(target) : observer.targets.size > 0) {
          observer.callback(
            [...observer.targets]
              .filter((element) => !target || element === target)
              .map((element) => ({ target: element, isIntersecting })),
          );
        }
      }
      flushFrames();
    },
    observesSize(target: Element) {
      return [...observers].some((observer) => observer.targets.has(target));
    },
    flush: flushFrames,
    resize(...targets: Element[]) {
      for (const target of targets) {
        for (const observer of observers) {
          if (observer.targets.has(target)) {
            // SAFETY: Only target is consumed by the resize delivery router.
            observer.callback([{ target } as ResizeObserverEntry], observer);
          }
        }
      }
      flushFrames();
    },
  };
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("dir");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const overflows = (label: Element) => label.classList.contains("hover-marquee--overflowing");
const scrolls = (label: Element) => label.classList.contains("hover-marquee--scrolling");
const shift = (label: HTMLElement) => label.style.getPropertyValue("--hover-marquee-shift");
const duration = (label: HTMLElement) => label.style.getPropertyValue("--hover-marquee-duration");
function reveal(clock: ReturnType<typeof measurementClock>) {
  clock.flush();
  clock.visible(true);
}
function advance(clock: ReturnType<typeof measurementClock>, ms: number) {
  vi.advanceTimersByTime(ms);
  clock.flush();
}

function denseTitles(count = 1, options: MarqueeOptions = {}) {
  const clock = measurementClock();
  const container = document.createElement("div");
  document.body.append(container);
  const initialTitle = "A long conversation title";
  const [props, setProps] = createSignal({ title: initialTitle, className: "session-name" });
  mountSolid(
    () =>
      Array.from({ length: count }, () => (
        <a class="session-row-host">
          <HoverMarquee content={props().title} class={props().className} options={options} />
        </a>
      )),
    { container },
  );
  const show = (title = initialTitle, className = "session-name") => {
    setProps({ title, className });
    flush();
  };
  flush();
  const labels = [...container.querySelectorAll<HTMLElement>(".hover-marquee")];
  const operations: string[] = [];
  for (const label of labels) {
    label.style.cssText = "white-space: nowrap; padding: 0; --hover-marquee-fade-width: 12px";
    Object.defineProperty(label, "clientWidth", { configurable: true, value: 100 });
    const text = label.querySelector<HTMLElement>(".hover-marquee__text")!;
    text.style.transform = "none";
    Object.defineProperty(text, "scrollWidth", {
      configurable: true,
      get: () => {
        operations.push("read");
        return text.textContent!.length * 8;
      },
    });
    const toggle = label.classList.toggle.bind(label.classList);
    vi.spyOn(label.classList, "toggle").mockImplementation((name, force) => {
      operations.push("write");
      return toggle(name, force);
    });
  }
  return {
    clock,
    show,
    labels,
    operations,
    label: labels[0]!,
    host: container.querySelector("a")!,
  };
}

describe("hover marquee measurement budget", () => {
  it.each([false, true])("defers unseen label measurement and observers (loop=%s)", (loop) => {
    const { clock, labels, operations } = denseTitles(2, { loop });
    const style = vi.spyOn(globalThis, "getComputedStyle");
    const observeContent = vi.spyOn(MutationObserver.prototype, "observe");
    clock.flush();
    clock.visible(false);
    expect(operations).toEqual([]);
    expect(style).not.toHaveBeenCalled();
    expect(observeContent).not.toHaveBeenCalled();
    expect(labels.some((label) => clock.observesSize(label))).toBe(false);
    clock.visible(true, labels[0]);
    expect(overflows(labels[0]!)).toBe(true);
    expect(clock.observesSize(labels[0]!)).toBe(true);
    expect(overflows(labels[1]!)).toBe(false);
    expect(clock.observesSize(labels[1]!)).toBe(false);
    expect(style.mock.calls.some(([element]) => element === labels[1])).toBe(false);
    clock.visible(true, labels[1]);
    expect(overflows(labels[1]!)).toBe(true);
    expect(clock.observesSize(labels[1]!)).toBe(true);
  });

  it("measures an explicitly stationary title without an interaction host", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { clock, label, show } = denseTitles(1, {
      host: () => undefined,
      stationaryWithoutHost: true,
    });
    reveal(clock);
    expect(overflows(label)).toBe(true);
    expect(scrolls(label)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    show("Short");
    clock.resize(label);
    expect(overflows(label)).toBe(false);
    expect(label.textContent).toBe("Short");
  });

  it("reads a dense title batch before writing overflow styles", () => {
    const { clock, labels, operations } = denseTitles(100);
    reveal(clock);
    expect(labels.every(overflows)).toBe(true);
    expect(operations.lastIndexOf("read")).toBeLessThan(operations.indexOf("write"));
    Object.defineProperty(labels[0]!, "clientWidth", { configurable: true, value: 0 });
    operations.length = 0;
    clock.resize(labels[0]!, labels[1]!);
    expect(overflows(labels[0]!)).toBe(false);
    expect(overflows(labels[1]!)).toBe(true);
    expect(operations).toEqual(["read", "write", "write"]);
  });

  it("avoids style resolution at zero width and resumes through the existing resize observer", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { clock, label, host } = denseTitles();
    let width = 0;
    Object.defineProperty(label, "clientWidth", { configurable: true, get: () => width });
    const style = vi.spyOn(globalThis, "getComputedStyle");
    const expectNoLabelStyleRead = () =>
      expect(style.mock.calls.filter(([element]) => element === label)).toEqual([]);
    const expectResting = () => {
      expect(overflows(label)).toBe(false);
      expect(scrolls(label)).toBe(false);
      expect(shift(label)).toBe("");
      expect(duration(label)).toBe("");
      expect(vi.getTimerCount()).toBe(0);
    };
    host.tabIndex = 0;
    host.focus();
    // Reused jsdom windows retain mouse modality from earlier files.
    host.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(document.activeElement).toBe(host);
    expect(host.matches(":focus-visible")).toBe(true);
    // Focusing collapses jsdom's selection and queues a separate selectionchange event.
    vi.advanceTimersByTime(0);
    reveal(clock);
    expectResting();
    expectNoLabelStyleRead();

    for (const revealBeforeHiding of [false, true]) {
      width = 100;
      clock.resize(label);
      expect(overflows(label)).toBe(true);
      expect(shift(label)).not.toBe("");
      expect(duration(label)).not.toBe("");
      expect(vi.getTimerCount()).toBe(1);
      if (revealBeforeHiding) {
        advance(clock, 500);
        expect(scrolls(label)).toBe(true);
      }
      style.mockClear();
      width = 0;
      clock.resize(label);
      expectResting();
      advance(clock, 500);
      expectResting();
      expectNoLabelStyleRead();
    }
  });

  it("skips unchanged titles but refreshes content, class, direction, and viewport changes", async () => {
    const { clock, show, labels, operations, host } = denseTitles(100);
    reveal(clock);
    operations.length = 0;
    for (let index = 0; index < 5; index += 1) {
      show();
      await clock.settle();
    }
    expect(operations).toHaveLength(0);
    const elapsed = document.createElement("span");
    host.append(elapsed);
    elapsed.textContent = "1s";
    await clock.settle();
    expect(operations).toHaveLength(0);
    show("Short");
    await clock.settle();
    expect(labels.every((label) => !overflows(label))).toBe(true);
    show("A long conversation title");
    await clock.settle();
    show("A long conversation title", "session-name renamed");
    clock.flush();
    expect(labels.every(overflows)).toBe(true);
    operations.length = 0;
    document.documentElement.dir = "rtl";
    await clock.settle();
    expect(operations.filter((operation) => operation === "read")).toHaveLength(100);
    Object.defineProperty(labels[0]!, "clientWidth", { configurable: true, value: 500 });
    operations.length = 0;
    clock.resize(labels[0]!);
    expect(operations.filter((operation) => operation === "read")).toHaveLength(1);
    expect(overflows(labels[0]!)).toBe(false);
    const text = labels[0]!.querySelector<HTMLElement>(".hover-marquee__text")!;
    Object.defineProperty(text, "scrollWidth", { value: 800 });
    clock.resize(text);
    expect(overflows(labels[0]!)).toBe(true);
  });

  it("measures sustained focus but not brief navigation or blur", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { clock, label, host } = denseTitles();
    host.tabIndex = 0;
    // jsdom does not model keyboard focus visibility consistently.
    const matches = host.matches.bind(host);
    vi.spyOn(host, "matches").mockImplementation((selector) =>
      selector === ":hover, :focus-visible" || selector === ":focus-visible"
        ? document.activeElement === host
        : matches(selector),
    );
    reveal(clock);
    const width = vi.fn(() => 100);
    Object.defineProperty(label, "clientWidth", { configurable: true, get: width });
    const style = vi.spyOn(globalThis, "getComputedStyle");

    host.focus();
    clock.flush();
    expect(width).not.toHaveBeenCalled();
    expect(style).not.toHaveBeenCalled();
    host.blur();
    advance(clock, 500);
    expect(width).not.toHaveBeenCalled();
    expect(style).not.toHaveBeenCalled();

    host.focus();
    advance(clock, 500);
    expect(scrolls(label)).toBe(true);
    expect(width).toHaveBeenCalledOnce();
    width.mockClear();
    style.mockClear();
    host.blur();
    clock.flush();

    expect(scrolls(label)).toBe(false);
    expect(overflows(label)).toBe(true);
    expect(width).not.toHaveBeenCalled();
    expect(style).not.toHaveBeenCalled();
  });

  it("follows touch menu intent, direction, visibility, and reduced motion for looping names", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { clock, label, host } = denseTitles(1, { loop: true, delay: 50 });
    reveal(clock);
    expect(scrolls(label)).toBe(false);
    host.setAttribute("aria-expanded", "true");
    await clock.settle();
    advance(clock, 50);
    expect(scrolls(label)).toBe(true);
    expect(Number.parseFloat(shift(label))).toBeLessThan(0);
    label.style.direction = "rtl";
    label.dir = "rtl";
    await clock.settle();
    expect(Number.parseFloat(shift(label))).toBeGreaterThan(0);
    clock.visible(false);
    expect(scrolls(label)).toBe(false);
    clock.visible(true);
    advance(clock, 50);
    expect(scrolls(label)).toBe(true);
    clock.motion.matches = true;
    clock.motion.dispatchEvent(new Event("change"));
    clock.flush();
    expect(scrolls(label)).toBe(false);
    clock.motion.matches = false;
    clock.motion.dispatchEvent(new Event("change"));
    clock.flush();
    advance(clock, 50);
    expect(scrolls(label)).toBe(true);
    host.setAttribute("aria-expanded", "false");
    await clock.settle();
    expect(scrolls(label)).toBe(false);
  });
});
