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
