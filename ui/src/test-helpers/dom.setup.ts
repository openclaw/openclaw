import { afterEach, vi } from "vitest";
import { installPopoverPolyfill } from "./popover.ts";
import { cleanupSolid } from "./solid-cleanup.ts";
import { installSafeLocalStorageForTesting } from "./storage.ts";

// Setup files run for every test file; ordinary helpers stay cached with isolate:false.
afterEach(cleanupSolid);

installPopoverPolyfill();

if (typeof document !== "undefined" && !("__vitest_browser__" in globalThis)) {
  // mock-isolation: JSDOM rendering tests assume admission; the real browser gate has E2E coverage.
  vi.doMock("../app/boot-capabilities.ts", () => ({ unsupportedControlUiBrowser: false }));

  // JSDOM has no layout. Geometry/visibility tests install controlled observers;
  // ordinary rendering fixtures treat their mounted content as visible.
  if (typeof matchMedia === "undefined") {
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      writable: true,
      value: (media: string) => ({
        media,
        matches: false,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => true,
      }),
    });
  }
  if (typeof ResizeObserver === "undefined") {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  }
  if (typeof IntersectionObserver === "undefined") {
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: class implements IntersectionObserver {
        readonly root: Document | Element | null;
        readonly rootMargin: string;
        readonly scrollMargin = "0px";
        readonly thresholds = [0];
        private readonly targets = new Set<Element>();

        constructor(
          private readonly callback: IntersectionObserverCallback,
          options?: IntersectionObserverInit,
        ) {
          this.root = options?.root ?? null;
          this.rootMargin = options?.rootMargin ?? "0px";
        }

        observe(target: Element) {
          this.targets.add(target);
          queueMicrotask(() => {
            if (!this.targets.has(target)) {
              return;
            }
            const bounds = target.getBoundingClientRect();
            this.callback(
              [
                {
                  target,
                  time: performance.now(),
                  rootBounds: null,
                  boundingClientRect: bounds,
                  intersectionRect: bounds,
                  intersectionRatio: 1,
                  isIntersecting: true,
                },
              ],
              this,
            );
          });
        }
        unobserve(target: Element) {
          this.targets.delete(target);
        }
        disconnect() {
          this.targets.clear();
        }
        takeRecords(): IntersectionObserverEntry[] {
          return [];
        }
      },
    });
  }

  if (!("checkVisibility" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "checkVisibility", {
      configurable: true,
      writable: true,
      value(this: Element) {
        return getComputedStyle(this).display !== "none";
      },
    });
  }

  if (!("scrollTo" in Element.prototype)) {
    Object.defineProperty(Element.prototype, "scrollTo", {
      configurable: true,
      writable: true,
      value(this: Element, optionsOrX?: ScrollToOptions | number, y?: number) {
        const options = typeof optionsOrX === "number" ? { left: optionsOrX, top: y } : optionsOrX;
        if (options?.left !== undefined) {
          this.scrollLeft = options.left;
        }
        if (options?.top !== undefined) {
          this.scrollTop = Math.max(
            0,
            Math.min(options.top, this.scrollHeight - this.clientHeight),
          );
        }
      },
    });
  }
}

// JSDOM has no Web Animations API; native overlay tests use an empty animation list.
if (typeof Element !== "undefined" && !("getAnimations" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
}

// JSDOM has no layout or scrolling; browser tests retain the native method.
if (typeof Element !== "undefined" && !("scrollIntoView" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: () => {},
  });
}

if (typeof HTMLDialogElement !== "undefined" && !("showModal" in HTMLDialogElement.prototype)) {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute("open", "");
    },
  });
}

if (typeof HTMLDialogElement !== "undefined" && !("close" in HTMLDialogElement.prototype)) {
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
}

// Node 25+ exposes accessor-backed WebStorage that can be disabled or inert.
// Vitest intentionally rejects all storage accessors, so jsdom needs an owned
// value descriptor even when invoking the original getter appears to work.
function globalLocalStorageIsUsable(): boolean {
  try {
    const existing = globalThis.localStorage;
    if (!existing) {
      return false;
    }
    existing.setItem("__openclaw_probe__", "1");
    const roundTrips = existing.getItem("__openclaw_probe__") === "1";
    existing.removeItem("__openclaw_probe__");
    return roundTrips;
  } catch {
    return false;
  }
}

if (
  typeof window !== "undefined" &&
  ((typeof process !== "undefined" && Boolean(process.env?.VITEST)) ||
    !globalLocalStorageIsUsable())
) {
  installSafeLocalStorageForTesting(window);
}
