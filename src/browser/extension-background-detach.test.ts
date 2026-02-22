import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error TS7016 — untyped JS module in assets/
import * as bgLogic from "../../assets/chrome-extension/background-logic.js";

const { cancelAllPendingReattach, handleDebuggerDetach } = bgLogic;

interface EventBus {
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  fire(...args: unknown[]): void;
  readonly listenerCount: number;
}

function createEventBus(): EventBus {
  const listeners: Array<(...args: unknown[]) => void> = [];
  return {
    addListener: vi.fn((fn: (...args: unknown[]) => void) => listeners.push(fn)),
    removeListener: vi.fn((fn: (...args: unknown[]) => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) {
        listeners.splice(i, 1);
      }
    }),
    fire(...args: unknown[]) {
      const snapshot = listeners.slice();
      for (const fn of snapshot) {
        fn(...args);
      }
    },
    get listenerCount() {
      return listeners.length;
    },
  };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    tabs: new Map(),
    pendingReattach: new Map(),
    setBadge: vi.fn(),
    detachTab: vi.fn().mockResolvedValue(undefined),
    ensureRelayConnection: vi.fn().mockResolvedValue(undefined),
    attachTab: vi.fn().mockResolvedValue({ sessionId: "s1", targetId: "t1" }),
    tabEvents: {
      onUpdated: createEventBus(),
      onRemoved: createEventBus(),
    },
    setTimeout: vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms)),
    clearTimeout: vi.fn((id: ReturnType<typeof setTimeout>) => clearTimeout(id)),
    ...overrides,
  };
}

describe("handleDebuggerDetach", () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = makeDeps();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- guards ---

  it("does nothing if source has no tabId", () => {
    handleDebuggerDetach({}, "target_crashed", deps);
    expect(deps.detachTab).not.toHaveBeenCalled();
    expect(deps.setBadge).not.toHaveBeenCalled();
  });

  it("does nothing if tabId is not in the tabs map", () => {
    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);
    expect(deps.detachTab).not.toHaveBeenCalled();
  });

  // --- permanent detach ---

  it("permanently detaches on canceled_by_user without registering listeners", () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });
    handleDebuggerDetach({ tabId: 42 }, "canceled_by_user", deps);

    expect(deps.detachTab).toHaveBeenCalledWith(42, "canceled_by_user");
    expect(deps.tabEvents.onUpdated.addListener).not.toHaveBeenCalled();
    expect(deps.pendingReattach.size).toBe(0);
  });

  it("permanently detaches on replaced_with_devtools", () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });
    handleDebuggerDetach({ tabId: 42 }, "replaced_with_devtools", deps);

    expect(deps.detachTab).toHaveBeenCalledWith(42, "replaced_with_devtools");
    expect(deps.tabEvents.onUpdated.addListener).not.toHaveBeenCalled();
  });

  // --- transient detach (reattach path) ---

  it("sets badge to connecting and registers both listeners", () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });
    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);

    expect(deps.setBadge).toHaveBeenCalledWith(42, "connecting");
    expect(deps.tabEvents.onUpdated.addListener).toHaveBeenCalledOnce();
    expect(deps.tabEvents.onRemoved.addListener).toHaveBeenCalledOnce();
    expect(deps.pendingReattach.has(42)).toBe(true);
  });

  it("reattaches when tab finishes loading", async () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });
    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);

    deps.tabEvents.onUpdated.fire(42, { status: "complete" });
    await vi.advanceTimersByTimeAsync(0);

    // Old session must be cleaned up before reattach to avoid orphaned
    // entries in tabBySession and missing detachedFromTarget relay events.
    expect(deps.detachTab).toHaveBeenCalledWith(42, "target_crashed");
    expect(deps.ensureRelayConnection).toHaveBeenCalledOnce();
    expect(deps.attachTab).toHaveBeenCalledWith(42);

    // Badge restored to 'connecting' after cleanup detach (which resets to 'off')
    expect(deps.setBadge).toHaveBeenCalledTimes(2);
    expect(deps.setBadge).toHaveBeenNthCalledWith(1, 42, "connecting");
    expect(deps.setBadge).toHaveBeenNthCalledWith(2, 42, "connecting");

    // Verify ordering: detachTab → ensureRelayConnection → attachTab
    const detachOrder = deps.detachTab.mock.invocationCallOrder[0];
    const relayOrder = deps.ensureRelayConnection.mock.invocationCallOrder[0];
    const attachOrder = deps.attachTab.mock.invocationCallOrder[0];
    expect(detachOrder).toBeLessThan(relayOrder);
    expect(relayOrder).toBeLessThan(attachOrder);

    expect(deps.tabEvents.onUpdated.listenerCount).toBe(0);
    expect(deps.tabEvents.onRemoved.listenerCount).toBe(0);
    expect(deps.pendingReattach.has(42)).toBe(false);
  });

  it("ignores onUpdated for wrong tab", async () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });
    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);

    deps.tabEvents.onUpdated.fire(99, { status: "complete" });
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.attachTab).not.toHaveBeenCalled();
    expect(deps.tabEvents.onUpdated.listenerCount).toBe(1);
  });

  it("ignores onUpdated for non-complete status", async () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });
    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);

    deps.tabEvents.onUpdated.fire(42, { status: "loading" });
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.attachTab).not.toHaveBeenCalled();
    expect(deps.tabEvents.onUpdated.listenerCount).toBe(1);
  });

  it("detaches with tab_closed when tab is removed during reattach", () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });
    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);

    deps.tabEvents.onRemoved.fire(42);

    expect(deps.detachTab).toHaveBeenCalledWith(42, "tab_closed");
    expect(deps.tabEvents.onUpdated.listenerCount).toBe(0);
    expect(deps.tabEvents.onRemoved.listenerCount).toBe(0);
    expect(deps.pendingReattach.has(42)).toBe(false);
  });

  it("ignores onRemoved for wrong tab", () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });
    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);

    deps.tabEvents.onRemoved.fire(99);

    expect(deps.detachTab).not.toHaveBeenCalled();
    expect(deps.tabEvents.onUpdated.listenerCount).toBe(1);
  });

  it("times out after 10s and detaches with original reason", async () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });
    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(deps.detachTab).toHaveBeenCalledWith(42, "target_crashed");
    expect(deps.tabEvents.onUpdated.listenerCount).toBe(0);
    expect(deps.tabEvents.onRemoved.listenerCount).toBe(0);
    expect(deps.pendingReattach.has(42)).toBe(false);
  });

  it("falls back to detachTab when reattach fails", async () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });
    deps.attachTab.mockRejectedValueOnce(new Error("attach failed"));
    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);

    deps.tabEvents.onUpdated.fire(42, { status: "complete" });
    await vi.advanceTimersByTimeAsync(0);

    // Called twice: first to clean up old session, then as fallback on attach failure.
    expect(deps.detachTab).toHaveBeenCalledTimes(2);
    expect(deps.detachTab).toHaveBeenNthCalledWith(1, 42, "target_crashed");
    expect(deps.detachTab).toHaveBeenNthCalledWith(2, 42, "target_crashed");
  });

  it("falls back to detachTab when relay connection fails", async () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });
    deps.ensureRelayConnection.mockRejectedValueOnce(new Error("relay down"));
    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);

    deps.tabEvents.onUpdated.fire(42, { status: "complete" });
    await vi.advanceTimersByTimeAsync(0);

    // Called twice: first to clean up old session, then as fallback on relay failure.
    expect(deps.detachTab).toHaveBeenCalledTimes(2);
    expect(deps.attachTab).not.toHaveBeenCalled();
  });

  it("does not double-detach when initial cleanup rejects", async () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });
    deps.detachTab.mockRejectedValueOnce(new Error("cleanup failed"));
    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);

    deps.tabEvents.onUpdated.fire(42, { status: "complete" });
    await vi.advanceTimersByTimeAsync(0);

    // Initial cleanup detachTab rejects — returns early without attempting reattach.
    // detachTab is NOT called a second time (separate try blocks prevent the
    // reattach catch from re-invoking detachTab for cleanup failures).
    expect(deps.detachTab).toHaveBeenCalledTimes(1);
    expect(deps.ensureRelayConnection).not.toHaveBeenCalled();
    expect(deps.attachTab).not.toHaveBeenCalled();
  });

  // --- rapid navigation guard ---

  it("cancels previous pending reattach on rapid re-detach", () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });

    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);
    expect(deps.tabEvents.onUpdated.listenerCount).toBe(1);
    expect(deps.tabEvents.onRemoved.listenerCount).toBe(1);

    handleDebuggerDetach({ tabId: 42 }, "target_crashed", deps);

    expect(deps.tabEvents.onUpdated.listenerCount).toBe(1);
    expect(deps.tabEvents.onRemoved.listenerCount).toBe(1);
    expect(deps.clearTimeout).toHaveBeenCalled();
    expect(deps.pendingReattach.size).toBe(1);
  });

  it("does not leak listeners across three rapid detaches", () => {
    deps.tabs.set(42, { state: "connected", sessionId: "s1" });

    handleDebuggerDetach({ tabId: 42 }, "nav1", deps);
    handleDebuggerDetach({ tabId: 42 }, "nav2", deps);
    handleDebuggerDetach({ tabId: 42 }, "nav3", deps);

    expect(deps.tabEvents.onUpdated.listenerCount).toBe(1);
    expect(deps.tabEvents.onRemoved.listenerCount).toBe(1);
    expect(deps.pendingReattach.size).toBe(1);
  });
});

describe("cancelAllPendingReattach", () => {
  it("calls all cleanup functions and clears the map", () => {
    const cleanups = [vi.fn(), vi.fn(), vi.fn()];
    const map = new Map<number, () => void>([
      [1, cleanups[0]],
      [2, cleanups[1]],
      [3, cleanups[2]],
    ]);

    cancelAllPendingReattach(map);

    for (const fn of cleanups) {
      expect(fn).toHaveBeenCalledOnce();
    }
    expect(map.size).toBe(0);
  });

  it("handles empty map", () => {
    const map = new Map<number, () => void>();
    cancelAllPendingReattach(map);
    expect(map.size).toBe(0);
  });
});
