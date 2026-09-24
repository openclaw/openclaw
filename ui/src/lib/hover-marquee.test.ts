/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHoverMarquee } from "./hover-marquee.ts";

function measurementClock() {
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const observers = new Set<ControlledResizeObserver>();
  const visibilityCallbacks: Array<(entries: { isIntersecting: boolean }[]) => void> = [];
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
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        visibilityCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => motion);
  return {
    motion,
    visible(isIntersecting: boolean) {
      visibilityCallbacks.forEach((callback) => callback([{ isIntersecting }]));
    },
    flush() {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    },
    resize(target: Element) {
      for (const observer of observers) {
        if (observer.targets.has(target)) {
          observer.callback([], observer);
        }
      }
    },
  };
}

afterEach(() => {
  for (const container of document.body.children) {
    if (container instanceof HTMLElement) {
      render(nothing, container);
    }
  }
  document.body.replaceChildren();
  document.documentElement.removeAttribute("dir");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function denseTitles(count: number, options: Parameters<typeof renderHoverMarquee>[2] = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const show = (title = "A long conversation title", className = "session-name") =>
    render(
      html`${Array.from(
        { length: count },
        () => html`<a class="session-row-host">
          ${renderHoverMarquee(html`${title}`, className, options)}
        </a>`,
      )}`,
      container,
    );
  show();
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
  return { container, show, labels, operations };
}

describe("hover marquee measurement budget", () => {
  it("reads a dense title batch before writing overflow styles", () => {
    const clock = measurementClock();
    const { labels, operations } = denseTitles(100);
    clock.flush();
    expect(labels.every((label) => label.classList.contains("hover-marquee--overflowing"))).toBe(
      true,
    );
    expect(operations.lastIndexOf("read")).toBeLessThan(operations.indexOf("write"));

    Object.defineProperty(labels[0]!, "clientWidth", { configurable: true, value: 0 });
    operations.length = 0;
    clock.resize(labels[0]!);
    clock.resize(labels[1]!);
    clock.flush();
    expect(labels[0]!.classList.contains("hover-marquee--overflowing")).toBe(false);
    expect(labels[1]!.classList.contains("hover-marquee--overflowing")).toBe(true);
    expect(operations).toEqual(["read", "write", "write"]);
  });

  it("avoids style resolution at zero width and resumes through the existing resize observer", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock = measurementClock();
    const { labels, container } = denseTitles(1);
    const label = labels[0]!;
    const host = container.querySelector("a")!;
    let width = 0;
    Object.defineProperty(label, "clientWidth", { configurable: true, get: () => width });
    const style = vi.spyOn(globalThis, "getComputedStyle");
    const expectNoLabelStyleRead = () =>
      expect(style.mock.calls.filter(([element]) => element === label)).toEqual([]);
    const expectResting = () => {
      expect(label.classList.contains("hover-marquee--overflowing")).toBe(false);
      expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
      expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("");
      expect(label.style.getPropertyValue("--hover-marquee-duration")).toBe("");
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
    clock.flush();
    expectResting();
    expectNoLabelStyleRead();

    for (const revealBeforeHiding of [false, true]) {
      width = 100;
      clock.resize(label);
      clock.flush();
      expect(label.classList.contains("hover-marquee--overflowing")).toBe(true);
      expect(label.style.getPropertyValue("--hover-marquee-shift")).not.toBe("");
      expect(label.style.getPropertyValue("--hover-marquee-duration")).not.toBe("");
      expect(vi.getTimerCount()).toBe(1);
      if (revealBeforeHiding) {
        vi.advanceTimersByTime(500);
        clock.flush();
        expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);
      }
      style.mockClear();
      width = 0;
      clock.resize(label);
      clock.flush();
      expectResting();
      vi.advanceTimersByTime(500);
      clock.flush();
      expectResting();
      expectNoLabelStyleRead();
    }
  });

  it("skips unchanged titles but refreshes content, class, direction, and viewport changes", async () => {
    const clock = measurementClock();
    const { show, labels, operations } = denseTitles(100);
    clock.flush();
    operations.length = 0;
    for (let index = 0; index < 5; index += 1) {
      show();
      await Promise.resolve();
      clock.flush();
    }
    expect(operations).toHaveLength(0);

    show("Short");
    await Promise.resolve();
    clock.flush();
    expect(labels.every((label) => !label.classList.contains("hover-marquee--overflowing"))).toBe(
      true,
    );
    show("A long conversation title");
    await Promise.resolve();
    clock.flush();
    show("A long conversation title", "session-name renamed");
    clock.flush();
    expect(labels.every((label) => label.classList.contains("hover-marquee--overflowing"))).toBe(
      true,
    );

    operations.length = 0;
    document.documentElement.dir = "rtl";
    await Promise.resolve();
    clock.flush();
    expect(operations.filter((operation) => operation === "read")).toHaveLength(100);

    Object.defineProperty(labels[0]!, "clientWidth", { configurable: true, value: 500 });
    operations.length = 0;
    clock.resize(labels[0]!);
    clock.flush();
    expect(operations.filter((operation) => operation === "read")).toHaveLength(1);
    expect(labels[0]!.classList.contains("hover-marquee--overflowing")).toBe(false);

    const text = labels[0]!.querySelector<HTMLElement>(".hover-marquee__text")!;
    Object.defineProperty(text, "scrollWidth", { value: 800 });
    clock.resize(text);
    clock.flush();
    expect(labels[0]!.classList.contains("hover-marquee--overflowing")).toBe(true);
  });

  it("follows touch menu intent, direction, visibility, and reduced motion for looping names", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clock = measurementClock();
    const { labels, container } = denseTitles(1, { loop: true, delay: 50 });
    const label = labels[0]!;
    const host = container.querySelector("a")!;
    clock.flush();
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    host.setAttribute("aria-expanded", "true");
    await Promise.resolve();
    clock.flush();
    vi.advanceTimersByTime(50);
    clock.flush();
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);
    expect(Number.parseFloat(label.style.getPropertyValue("--hover-marquee-shift"))).toBeLessThan(
      0,
    );

    label.style.direction = "rtl";
    label.dir = "rtl";
    await Promise.resolve();
    clock.flush();
    expect(
      Number.parseFloat(label.style.getPropertyValue("--hover-marquee-shift")),
    ).toBeGreaterThan(0);

    clock.visible(false);
    clock.flush();
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    clock.visible(true);
    clock.flush();
    vi.advanceTimersByTime(50);
    clock.flush();
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);

    clock.motion.matches = true;
    clock.motion.dispatchEvent(new Event("change"));
    clock.flush();
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    clock.motion.matches = false;
    clock.motion.dispatchEvent(new Event("change"));
    clock.flush();
    vi.advanceTimersByTime(50);
    clock.flush();
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);

    host.setAttribute("aria-expanded", "false");
    await Promise.resolve();
    clock.flush();
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
  });
});
