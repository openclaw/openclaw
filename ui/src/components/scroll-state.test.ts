/* @vitest-environment jsdom */
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollState } from "./scroll-state.ts";
import { SessionDataScrollController } from "./session-data-scroll-controller.ts";

let container: HTMLDivElement;
let fonts: EventTarget;
let previousFonts: PropertyDescriptor | undefined;
const observers = new Map<
  ResizeObserver,
  { callback: ResizeObserverCallback; targets: Set<Element> }
>();
const intersections = new Map<Element, IntersectionObserverCallback>();
const unseen = new Set<Element>();
function visibility(element: Element, visible: boolean) {
  intersections.get(element)?.(
    [{ target: element, isIntersecting: visible } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
}
function layoutFrame() {
  for (const element of unseen) {
    visibility(element, true);
  }
  unseen.clear();
  vi.advanceTimersToNextFrame();
  for (const [observer, { callback, targets }] of observers) {
    if (targets.has(document.documentElement)) {
      callback([], observer);
    }
  }
}
function resize(element: Element) {
  for (const [observer, { callback, targets }] of observers) {
    if (targets.has(element)) {
      callback([{ target: element } as ResizeObserverEntry], observer);
    }
  }
}
const observe = vi.fn();
const unobserve = vi.fn();

beforeEach(() => {
  previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  fonts = new EventTarget();
  Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.set(this as ResizeObserver, { callback, targets: new Set() });
      }
      observe = (target: Element) => {
        observe(target);
        observers.get(this as ResizeObserver)!.targets.add(target);
      };
      unobserve = (target: Element) => {
        unobserve(target);
        observers.get(this as ResizeObserver)!.targets.delete(target);
      };
      disconnect = () => observers.get(this as ResizeObserver)!.targets.clear();
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe = (target: Element) => {
        intersections.set(target, this.callback);
        unseen.add(target);
      };
      unobserve = (target: Element) => intersections.delete(target);
      disconnect = () => intersections.clear();
    },
  );
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => {
  render(nothing, container);
  container.remove();
  if (previousFonts) {
    Object.defineProperty(document, "fonts", previousFonts);
  } else {
    Reflect.deleteProperty(document, "fonts");
  }
  observers.clear();
  intersections.clear();
  unseen.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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
    checkVisibility: { configurable: true, value: () => !element.hidden },
  });
}

describe("scroll state observation", () => {
  it("batches every scroller read before publishing after a Lit update", async () => {
    render(
      html`<div ${scrollState()}></div>
        <div ${scrollState()}></div>`,
      container,
    );
    const elements = [...container.children] as HTMLElement[];
    const order: string[] = [];
    elements.forEach((element, index) => {
      geometry(element, order, `read-${index}`);
      Object.defineProperty(element, "dataset", {
        value: new Proxy(element.dataset, {
          set(target, key, value) {
            order.push("write");
            return Reflect.set(target, key, value);
          },
        }),
      });
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    elements.forEach((element) => visibility(element, true));
    vi.advanceTimersToNextFrame();
    expect(order).toEqual([]);
    layoutFrame();
    expect(order).toEqual(["read-0", "read-1", ...Array<string>(6).fill("write")]);
    expect(
      elements.map((element) => ({
        scrollable: element.dataset.scrollable,
        atStart: element.dataset.atStart,
        atEnd: element.dataset.atEnd,
      })),
    ).toEqual([
      { scrollable: "true", atStart: "true", atEnd: "false" },
      { scrollable: "true", atStart: "true", atEnd: "false" },
    ]);
    order.length = 0;
    elements[0]!.dispatchEvent(new Event("scroll"));
    elements[0]!.dispatchEvent(new Event("scroll"));
    expect(order).toEqual([]);
    layoutFrame();
    expect(order).toEqual(["read-0"]);
  });

  it("updates scroll boundaries after resize and stops observing disconnected directives", () => {
    render(html`<div ${scrollState()}></div>`, container);
    const element = container.firstElementChild as HTMLElement;
    geometry(element, [], "read");
    layoutFrame();
    element.scrollTop = 100;
    resize(element);
    expect(element.dataset.atEnd).toBe("false");
    layoutFrame();
    expect(element.dataset.atEnd).toBe("true");
    render(nothing, container);
    expect(unobserve).toHaveBeenCalledWith(element);
  });

  it("tracks visible and intrinsic growth without measuring unchanged or offscreen content", async () => {
    const view = (label: string) =>
      html`<div ${scrollState()}>
        <span>${label}<img /></span>
      </div>`;
    render(view("One"), container);
    const element = container.firstElementChild as HTMLElement;
    const reads: string[] = [];
    geometry(element, reads, "read");
    layoutFrame();
    await Promise.resolve();
    layoutFrame();
    reads.length = 0;
    render(view("One"), container);
    await Promise.resolve();
    layoutFrame();
    expect(reads).toEqual([]);

    render(view("Two"), container);
    await Promise.resolve();
    layoutFrame();
    expect(reads).toEqual(["read"]);
    reads.length = 0;

    visibility(element, false);
    render(view("Three"), container);
    await Promise.resolve();
    layoutFrame();
    expect(reads).toEqual([]);
    visibility(element, true);
    layoutFrame();
    expect(reads).toEqual(["read"]);

    reads.length = 0;
    element.querySelector("img")!.dispatchEvent(new Event("load"));
    layoutFrame();
    expect(reads).toEqual(["read"]);
    reads.length = 0;
    fonts.dispatchEvent(new Event("loadingdone"));
    layoutFrame();
    expect(reads).toEqual(["read"]);
  });

  it("shares a frame with the sidebar and never reads from its update entry point", () => {
    render(html`<div class="sidebar-shell__body" ${scrollState()}></div>`, container);
    const element = container.firstElementChild as HTMLElement;
    const reads: string[] = [];
    geometry(element, reads, "read");
    const notify = vi.fn();
    const sidebar = new SessionDataScrollController(notify);
    try {
      sidebar.synchronize(container);
      sidebar.update(element);
      expect(reads).toEqual([]);
      layoutFrame();
      expect(reads).toEqual(["read"]);
      expect(sidebar.state).toBe("top");
      element.scrollTop = 50;
      sidebar.update(element);
      layoutFrame();
      expect(sidebar.state).toBe("middle");
      expect(notify).toHaveBeenCalledTimes(2);
    } finally {
      sidebar.dispose();
    }
  });
});
