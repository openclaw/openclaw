import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let page: Record<string, unknown> | null = null;

const forceDisconnectPlaywrightForTarget = vi.fn(async () => {});
const getPageForTargetId = vi.fn(async () => {
  if (!page) {
    throw new Error("test: page not set");
  }
  return page;
});
const ensurePageState = vi.fn(() => {});
const storeRoleRefsForTarget = vi.fn(() => {});

vi.mock("./pw-session.js", () => ({
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  storeRoleRefsForTarget,
}));

let snapshotAiViaPlaywright: typeof import("./pw-tools-core.snapshot.js").snapshotAiViaPlaywright;

describe("snapshotAiViaPlaywright (abort)", () => {
  beforeAll(async () => {
    ({ snapshotAiViaPlaywright } = await import("./pw-tools-core.snapshot.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disconnects the target when an AI snapshot is aborted after it starts", async () => {
    const ctrl = new AbortController();
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const pendingSnapshot = new Promise(() => {});

    page = {
      _snapshotForAI: vi.fn(() => {
        resolveStarted();
        return pendingSnapshot;
      }),
    };

    const promise = snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "page-1",
      signal: ctrl.signal,
    });

    await started;
    ctrl.abort(new Error("snapshot aborted"));

    await expect(promise).rejects.toThrow("snapshot aborted");
    expect(forceDisconnectPlaywrightForTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "page-1",
      }),
    );
  });

  it("rejects immediately on abort even if snapshot disconnect cleanup is still pending", async () => {
    const ctrl = new AbortController();
    let resolveStarted!: () => void;
    let resolveSnapshot!: () => void;
    let resolveDisconnect!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const pendingSnapshot = new Promise<void>((resolve) => {
      resolveSnapshot = resolve;
    });
    forceDisconnectPlaywrightForTarget.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          resolveDisconnect = resolve;
        }),
    );

    page = {
      _snapshotForAI: vi.fn(() => {
        resolveStarted();
        return pendingSnapshot;
      }),
    };

    const promise = snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "page-1",
      signal: ctrl.signal,
    });

    await started;
    ctrl.abort(new Error("snapshot abort should win"));
    resolveSnapshot();

    await expect(promise).rejects.toThrow("snapshot abort should win");
    resolveDisconnect();
  });
});
