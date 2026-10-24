import { afterEach, vi } from "vitest";
import { installPopoverPolyfill } from "./popover.ts";
import { cleanupSolid } from "./solid-cleanup.ts";
import { installSafeLocalStorageForTesting } from "./storage.ts";

// Setup files run for every test file; ordinary helpers stay cached with isolate:false.
afterEach(cleanupSolid);

installPopoverPolyfill();

function defineMissing(target: object | undefined, key: string, descriptor: PropertyDescriptor) {
  if (target && !(key in target)) {
    Object.defineProperty(target, key, { configurable: true, ...descriptor });
  }
}

if (typeof document !== "undefined" && !("__vitest_browser__" in globalThis)) {
  // mock-isolation: JSDOM rendering tests assume admission; the real browser gate has E2E coverage.
  vi.doMock("../app/boot-capabilities.ts", () => ({ unsupportedControlUiBrowser: false }));

  // JSDOM does not load fonts; browser layout tests retain the native FontFaceSet.
  if (!document.fonts) {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: Object.assign(new EventTarget(), { ready: Promise.resolve() }),
    });
  }

  // JSDOM has no layout. Geometry/visibility tests install controlled observers;
  // ordinary rendering fixtures treat their mounted content as visible.
  const globals = {
    matchMedia: (media: string) => ({
      media,
      matches: false,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    }),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IntersectionObserver: class implements IntersectionObserver {
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
          const entry = {
            target,
            time: performance.now(),
            rootBounds: null,
            boundingClientRect: bounds,
            intersectionRect: bounds,
            intersectionRatio: 1,
            isIntersecting: true,
          };
          this.callback([entry], this);
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
  };
  for (const [key, value] of Object.entries(globals)) {
    if (Reflect.get(globalThis, key) === undefined) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
  }

  defineMissing(Element.prototype, "checkVisibility", {
    writable: true,
    value(this: Element) {
      return getComputedStyle(this).display !== "none";
    },
  });

  defineMissing(Element.prototype, "scrollTo", {
    writable: true,
    value(this: Element, optionsOrX?: ScrollToOptions | number, y?: number) {
      const options = typeof optionsOrX === "number" ? { left: optionsOrX, top: y } : optionsOrX;
      if (options?.left !== undefined) {
        this.scrollLeft = options.left;
      }
      if (options?.top !== undefined) {
        this.scrollTop = Math.max(0, Math.min(options.top, this.scrollHeight - this.clientHeight));
      }
    },
  });
}

// JSDOM has no Web Animations API; native overlay tests use an empty animation list.
const elementPrototype = typeof Element === "undefined" ? undefined : Element.prototype;
defineMissing(elementPrototype, "getAnimations", { value: () => [] });

// JSDOM has no layout or scrolling; browser tests retain the native method.
defineMissing(elementPrototype, "scrollIntoView", { writable: true, value: () => {} });

const dialogPrototype =
  typeof HTMLDialogElement === "undefined" ? undefined : HTMLDialogElement.prototype;
defineMissing(dialogPrototype, "showModal", {
  value(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  },
});
defineMissing(dialogPrototype, "close", {
  value(this: HTMLDialogElement) {
    this.removeAttribute("open");
  },
});

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
