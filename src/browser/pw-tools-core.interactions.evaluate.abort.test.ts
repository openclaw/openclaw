import { describe, expect, it, vi } from "vitest";

let page: { evaluate: ReturnType<typeof vi.fn> } | null = null;
let locator: { evaluate: ReturnType<typeof vi.fn> } | null = null;

const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const getPageForTargetId = vi.fn(async () => {
  if (!page) {
    throw new Error("test: page not set");
  }
  return page;
});
const ensurePageState = vi.fn(() => {});
const restoreRoleRefsForTarget = vi.fn(() => {});
const refLocator = vi.fn(() => {
  if (!locator) {
    throw new Error("test: locator not set");
  }
  return locator;
});

vi.mock("./pw-session.js", () => {
  return {
    ensurePageState,
    forceDisconnectPlaywrightForTarget,
    getPageForTargetId,
    refLocator,
    restoreRoleRefsForTarget,
  };
});

describe("evaluateViaPlaywright (abort)", () => {
  it("rejects when aborted after page.evaluate starts", async () => {
    vi.clearAllMocks();
    const ctrl = new AbortController();

    let evalCalled!: () => void;
    const evalCalledPromise = new Promise<void>((resolve) => {
      evalCalled = resolve;
    });

    page = {
      evaluate: vi.fn(() => {
        evalCalled();
        return new Promise(() => {});
      }),
    };
    locator = { evaluate: vi.fn() };

    const { evaluateViaPlaywright } = await import("./pw-tools-core.interactions.js");
    const p = evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      fn: "() => 1",
      signal: ctrl.signal,
    });

    await evalCalledPromise;
    ctrl.abort(new Error("aborted by test"));

    await expect(p).rejects.toThrow("aborted by test");
    expect(forceDisconnectPlaywrightForTarget).toHaveBeenCalled();
  });

  it("rejects when aborted after locator.evaluate starts", async () => {
    vi.clearAllMocks();
    const ctrl = new AbortController();

    let evalCalled!: () => void;
    const evalCalledPromise = new Promise<void>((resolve) => {
      evalCalled = resolve;
    });

    page = { evaluate: vi.fn() };
    locator = {
      evaluate: vi.fn(() => {
        evalCalled();
        return new Promise(() => {});
      }),
    };

    const { evaluateViaPlaywright } = await import("./pw-tools-core.interactions.js");
    const p = evaluateViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      fn: "(el) => el.textContent",
      ref: "e1",
      signal: ctrl.signal,
    });

    await evalCalledPromise;
    ctrl.abort(new Error("aborted by test"));

    await expect(p).rejects.toThrow("aborted by test");
    expect(forceDisconnectPlaywrightForTarget).toHaveBeenCalled();
  });
});
