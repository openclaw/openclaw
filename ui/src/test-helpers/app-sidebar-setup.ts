import { afterEach, beforeEach, onTestFinished, vi } from "vitest";
import type { AppSidebarSessionNavigationElement } from "../components/app-sidebar-session-navigation.ts";
import { disposeSidebarContextLifecycles } from "./app-sidebar-context-lifecycle.ts";
import { settleLitElements } from "./lit-settle.ts";
import { createStorageMock } from "./storage.ts";

export function setupSidebarTest() {
  let originalLocalStorage: PropertyDescriptor | undefined;
  let layoutGlobals: Array<[string, PropertyDescriptor | undefined]>;

  beforeEach(() => {
    layoutGlobals = ["matchMedia", "ResizeObserver", "IntersectionObserver"].map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]);
    // JSDOM has no media queries or layout observation. Real browser tests keep
    // their native implementations and own the layout and motion assertions.
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

    for (const name of ["ResizeObserver", "IntersectionObserver"] as const) {
      if (globalThis[name] !== undefined) {
        continue;
      }
      Object.defineProperty(globalThis, name, {
        configurable: true,
        writable: true,
        value: class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
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

// jsdom does not reliably track :focus-visible across these synthetic events.
// Model the keyboard intent requested by each fixture, only while its target
// is actually focused. Real browser E2E owns pointer/keyboard modality proof.
export function focusSidebarPersonWithKeyboard(target: HTMLElement): void {
  const matches = target.matches.bind(target);
  const keyboardFocus = vi
    .spyOn(target, "matches")
    .mockImplementation((selector) =>
      selector === ":focus-visible" ? matches(":focus") : matches(selector),
    );
  onTestFinished(() => keyboardFocus.mockRestore());
  target.focus();
}
