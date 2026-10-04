import { afterEach, beforeEach, vi } from "vitest";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
import { disposeSidebarContextLifecycles } from "./app-sidebar-context-lifecycle.ts";
import { settleLitElements } from "./lit-settle.ts";
import { createStorageMock } from "./storage.ts";

export function setupSidebarTest() {
  let originalLocalStorage: PropertyDescriptor | undefined;
  let originalRangeBounds: PropertyDescriptor | undefined;
  let layoutGlobals: Array<[string, PropertyDescriptor | undefined]>;

  beforeEach(() => {
    layoutGlobals = ["matchMedia", "ResizeObserver"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]);
    // JSDOM has no media queries or layout geometry. Real browser tests keep
    // their native implementations and own the motion and resize assertions.
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

    originalRangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
    if (Range.prototype.getBoundingClientRect === undefined) {
      Object.defineProperty(Range.prototype, "getBoundingClientRect", {
        configurable: true,
        value: () => new DOMRect(),
      });
    }

    originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: createStorageMock(),
    });
    // Coding defaults to compact; most cases assert expanded contents, so start
    // expanded. Collapse tests override this value.
    localStorage.setItem("openclaw:sidebar:sessions:collapsed-sections", JSON.stringify([]));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await vi.dynamicImportSettled();
    // Removing a prompt's DOM does not settle its promise or release its reentrancy guard.
    for (const modal of document.body.querySelectorAll("openclaw-modal-dialog")) {
      modal.dispatchEvent(new CustomEvent("modal-cancel", { cancelable: true }));
    }
    await vi.dynamicImportSettled();
    const sidebars =
      document.body.querySelectorAll<AppSidebarSessionNavigationElement>("openclaw-app-sidebar");
    document.body.replaceChildren();
    disposeSidebarContextLifecycles();
    // Disconnection queues Lit updates; finish them before retiring the DOM globals.
    await settleLitElements(sidebars);
    if (originalRangeBounds) {
      Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeBounds);
    } else {
      Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
    }
    for (const [name, descriptor] of layoutGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, name);
      }
    }
    if (originalLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    } else {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
}
