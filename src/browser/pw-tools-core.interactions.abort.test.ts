import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let page: Record<string, unknown> | null = null;
let locator: { click: ReturnType<typeof vi.fn> } | null = null;

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

vi.mock("./pw-session.js", () => ({
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  refLocator,
  restoreRoleRefsForTarget,
}));

let clickViaPlaywright: typeof import("./pw-tools-core.interactions.js").clickViaPlaywright;

describe("clickViaPlaywright (abort)", () => {
  beforeAll(async () => {
    ({ clickViaPlaywright } = await import("./pw-tools-core.interactions.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disconnects the target when a click is aborted after it starts", async () => {
    const ctrl = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const pendingClick = new Promise<void>(() => {});

    page = {};
    locator = {
      click: vi.fn(() => {
        resolveStarted();
        return pendingClick;
      }),
    };

    const promise = clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "page-1",
      ref: "e1",
      signal: ctrl.signal,
    });

    await started;
    ctrl.abort(new Error("aborted by test"));

    await expect(promise).rejects.toThrow("aborted by test");
    expect(forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "page-1",
      }),
    );
  });

  it("rejects immediately on abort even if disconnect cleanup is still pending", async () => {
    const ctrl = new AbortController();
    let resolveStarted!: () => void;
    let resolveClick!: () => void;
    let resolveDisconnect!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const pendingClick = new Promise<void>((resolve) => {
      resolveClick = resolve;
    });
    forceDisconnectPlaywrightForTarget.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          resolveDisconnect = resolve;
        }),
    );

    page = {};
    locator = {
      click: vi.fn(() => {
        resolveStarted();
        return pendingClick;
      }),
    };

    const promise = clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "page-1",
      ref: "e1",
      signal: ctrl.signal,
    });

    await started;
    ctrl.abort(new Error("abort should win"));
    resolveClick();

    await expect(promise).rejects.toThrow("abort should win");
    resolveDisconnect();
  });
});
