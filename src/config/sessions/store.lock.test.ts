import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const acquireSessionWriteLockMock = vi.hoisted(() =>
  vi.fn(async () => ({ release: vi.fn(async () => {}) })),
);

let withSessionStoreLockForTest: typeof import("./store.js").withSessionStoreLockForTest;
let clearSessionStoreCacheForTest: typeof import("./store.js").clearSessionStoreCacheForTest;

async function loadFreshStoreModule() {
  vi.resetModules();
  vi.doMock("../../agents/session-write-lock.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../../agents/session-write-lock.js")>();
    return {
      ...original,
      acquireSessionWriteLock: acquireSessionWriteLockMock,
    };
  });
  ({ withSessionStoreLockForTest, clearSessionStoreCacheForTest } = await import("./store.js"));
}

describe("withSessionStoreLock", () => {
  beforeEach(async () => {
    acquireSessionWriteLockMock.mockClear();
    await loadFreshStoreModule();
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
    vi.restoreAllMocks();
  });

  it("derives session lock hold time from the store lock timeout", async () => {
    await withSessionStoreLockForTest("/tmp/openclaw-store.json", async () => {}, {
      timeoutMs: 10_000,
    });

    expect(acquireSessionWriteLockMock).toHaveBeenCalledWith({
      sessionFile: "/tmp/openclaw-store.json",
      timeoutMs: 10_000,
      staleMs: 30_000,
      maxHoldMs: 15_000,
    });
  });

  it("leaves the session lock hold time unset when store locking has no timeout", async () => {
    await withSessionStoreLockForTest("/tmp/openclaw-store.json", async () => {}, {
      timeoutMs: 0,
    });

    expect(acquireSessionWriteLockMock).toHaveBeenCalledWith({
      sessionFile: "/tmp/openclaw-store.json",
      timeoutMs: Number.POSITIVE_INFINITY,
      staleMs: 30_000,
      maxHoldMs: undefined,
    });
  });
});
