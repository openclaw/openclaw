import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTaskFlowById,
  listTaskFlowsForOwnerKey,
  resetTaskFlowRegistryForTests,
} from "../tasks/task-flow-registry.js";
import type { finishFlow as finishFlowType } from "../tasks/task-flow-registry.js";

const hoisted = vi.hoisted(() => ({
  finishFlowSpy: vi.fn(),
  realFinishFlow: null as null | typeof finishFlowType,
}));
const { finishFlowSpy } = hoisted;
vi.mock("../tasks/task-flow-registry.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../tasks/task-flow-registry.js")>();
  hoisted.realFinishFlow = mod.finishFlow;
  hoisted.finishFlowSpy.mockImplementation((params: Parameters<typeof mod.finishFlow>[0]) =>
    mod.finishFlow(params),
  );
  return {
    ...mod,
    finishFlow: (params: Parameters<typeof mod.finishFlow>[0]) => hoisted.finishFlowSpy(params),
  };
});
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  taskFlowCancelPendingDelegates,
  taskFlowConsumePendingDelegates,
  taskFlowEnqueuePendingDelegate,
  taskFlowPendingDelegateCount,
} from "./continuation-delegate-store-taskflow.js";
import {
  cancelPendingDelegates,
  consumePendingDelegates,
  enqueuePendingDelegate,
  isTaskFlowDelegatesEnabled,
  pendingDelegateCount,
  setTaskFlowDelegatesEnabled,
} from "./continuation-delegate-store.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

async function withFlowRegistryTempDir<T>(run: () => Promise<T>): Promise<T> {
  return await withTempDir({ prefix: "openclaw-delegate-taskflow-" }, async (root) => {
    process.env.OPENCLAW_STATE_DIR = root;
    resetTaskFlowRegistryForTests();
    try {
      return await run();
    } finally {
      resetTaskFlowRegistryForTests();
    }
  });
}

describe("continuation-delegate-store-taskflow", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    finishFlowSpy.mockRestore();
    // Re-bind default delegation to real implementation after restore.
    if (hoisted.realFinishFlow) {
      finishFlowSpy.mockImplementation((params: Parameters<typeof finishFlowType>[0]) =>
        hoisted.realFinishFlow!(params),
      );
    }
    setTaskFlowDelegatesEnabled(false);
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskFlowRegistryForTests();
  });

  it("returns empty array when no delegates pending", async () => {
    await withFlowRegistryTempDir(async () => {
      expect(taskFlowConsumePendingDelegates("test-session")).toEqual([]);
    });
  });

  it("enqueues and consumes a single delegate", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowEnqueuePendingDelegate("test-session", {
        task: "summarize the RFC",
        delayMs: 30000,
        silent: false,
        silentWake: false,
      });

      const delegates = taskFlowConsumePendingDelegates("test-session");
      expect(delegates).toHaveLength(1);
      expect(delegates[0].task).toBe("summarize the RFC");
      expect(delegates[0].delayMs).toBe(30000);
    });
  });

  it("consume removes delegates from store", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowEnqueuePendingDelegate("test-session", { task: "task 1" });

      const first = taskFlowConsumePendingDelegates("test-session");
      expect(first).toHaveLength(1);

      const second = taskFlowConsumePendingDelegates("test-session");
      expect(second).toEqual([]);
    });
  });

  it("supports multiple delegates per session (multi-arrow fan-out)", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowEnqueuePendingDelegate("test-session", { task: "arrow 1", delayMs: 10000 });
      taskFlowEnqueuePendingDelegate("test-session", {
        task: "arrow 2",
        delayMs: 20000,
        silent: true,
      });
      taskFlowEnqueuePendingDelegate("test-session", {
        task: "arrow 3",
        delayMs: 30000,
        silentWake: true,
      });

      const delegates = taskFlowConsumePendingDelegates("test-session");
      expect(delegates).toHaveLength(3);
      expect(delegates[0].task).toBe("arrow 1");
      expect(delegates[1].task).toBe("arrow 2");
      expect(delegates[1].silent).toBe(true);
      expect(delegates[2].task).toBe("arrow 3");
      expect(delegates[2].silentWake).toBe(true);
    });
  });

  it("isolates delegates by session key", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowEnqueuePendingDelegate("test-session", { task: "session A task" });
      taskFlowEnqueuePendingDelegate("other-session", { task: "session B task" });

      const a = taskFlowConsumePendingDelegates("test-session");
      const b = taskFlowConsumePendingDelegates("other-session");

      expect(a).toHaveLength(1);
      expect(a[0].task).toBe("session A task");
      expect(b).toHaveLength(1);
      expect(b[0].task).toBe("session B task");
    });
  });

  it("pendingDelegateCount reflects current queue depth", async () => {
    await withFlowRegistryTempDir(async () => {
      expect(taskFlowPendingDelegateCount("test-session")).toBe(0);

      taskFlowEnqueuePendingDelegate("test-session", { task: "task 1" });
      expect(taskFlowPendingDelegateCount("test-session")).toBe(1);

      taskFlowEnqueuePendingDelegate("test-session", { task: "task 2" });
      expect(taskFlowPendingDelegateCount("test-session")).toBe(2);

      taskFlowConsumePendingDelegates("test-session");
      expect(taskFlowPendingDelegateCount("test-session")).toBe(0);
    });
  });

  it("handles delegates with no optional fields", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowEnqueuePendingDelegate("test-session", { task: "minimal task" });

      const delegates = taskFlowConsumePendingDelegates("test-session");
      expect(delegates).toHaveLength(1);
      expect(delegates[0]).toEqual({ task: "minimal task" });
    });
  });

  it("handles zero delay (immediate dispatch)", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowEnqueuePendingDelegate("test-session", { task: "immediate", delayMs: 0 });

      const delegates = taskFlowConsumePendingDelegates("test-session");
      expect(delegates[0].delayMs).toBe(0);
    });
  });

  it("cancel removes all pending delegates for a session", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowEnqueuePendingDelegate("test-session", { task: "task 1" });
      taskFlowEnqueuePendingDelegate("test-session", { task: "task 2" });
      expect(taskFlowPendingDelegateCount("test-session")).toBe(2);

      taskFlowCancelPendingDelegates("test-session");

      expect(taskFlowPendingDelegateCount("test-session")).toBe(0);
      expect(taskFlowConsumePendingDelegates("test-session")).toEqual([]);
    });
  });

  it("cancel does not affect other sessions", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowEnqueuePendingDelegate("test-session", { task: "session A" });
      taskFlowEnqueuePendingDelegate("other-session", { task: "session B" });

      taskFlowCancelPendingDelegates("test-session");

      expect(taskFlowPendingDelegateCount("test-session")).toBe(0);
      expect(taskFlowPendingDelegateCount("other-session")).toBe(1);
    });
  });

  it("cancel is idempotent on empty session", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowCancelPendingDelegates("test-session");
      expect(taskFlowPendingDelegateCount("test-session")).toBe(0);
    });
  });

  it("delegates persist across simulated restart (registry reset + reload)", async () => {
    await withTempDir({ prefix: "openclaw-delegate-persist-" }, async (root) => {
      process.env.OPENCLAW_STATE_DIR = root;
      resetTaskFlowRegistryForTests();

      taskFlowEnqueuePendingDelegate("test-session", {
        task: "survive restart",
        delayMs: 5000,
        silent: true,
      });

      // Simulate a restart: reset in-memory state but keep SQLite on disk.
      resetTaskFlowRegistryForTests({ persist: false });

      // After restart, delegates should be recoverable.
      const delegates = taskFlowConsumePendingDelegates("test-session");
      expect(delegates).toHaveLength(1);
      expect(delegates[0].task).toBe("survive restart");
      expect(delegates[0].delayMs).toBe(5000);
      expect(delegates[0].silent).toBe(true);

      resetTaskFlowRegistryForTests();
    });
  });

  it("consume transitions flow records to succeeded (not deleted)", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowEnqueuePendingDelegate("test-session", { task: "lifecycle task" });

      // Capture flow ID before consume.
      const pendingFlows = listTaskFlowsForOwnerKey("test-session");
      expect(pendingFlows).toHaveLength(1);
      const flowId = pendingFlows[0].flowId;

      taskFlowConsumePendingDelegates("test-session");

      // Record still exists with "succeeded" status.
      const flow = getTaskFlowById(flowId);
      expect(flow).toBeDefined();
      expect(flow!.status).toBe("succeeded");
      expect(flow!.endedAt).toBeGreaterThan(0);
    });
  });

  it("cancel transitions flow records to cancelled with cancel intent (not deleted)", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowEnqueuePendingDelegate("test-session", { task: "cancel me" });

      const pendingFlows = listTaskFlowsForOwnerKey("test-session");
      const flowId = pendingFlows[0].flowId;

      taskFlowCancelPendingDelegates("test-session");

      // Record persists with cancelled status and cancel timestamp.
      const flow = getTaskFlowById(flowId);
      expect(flow).toBeDefined();
      expect(flow!.status).toBe("cancelled");
      expect(flow!.cancelRequestedAt).toBeGreaterThan(0);
      expect(flow!.endedAt).toBeGreaterThan(0);
    });
  });

  it("returns all delegates even when finishFlow throws for some flows", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowEnqueuePendingDelegate("test-session", { task: "task 1" });
      taskFlowEnqueuePendingDelegate("test-session", { task: "task 2" });
      taskFlowEnqueuePendingDelegate("test-session", { task: "task 3" });

      // Make finishFlow throw on the second call (flow #2 of 3).
      let callCount = 0;
      finishFlowSpy.mockImplementation((...args: unknown[]) => {
        callCount++;
        if (callCount === 2) {
          throw new Error("simulated SQLite failure");
        }
        return (hoisted.realFinishFlow as Function)(...args);
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        // Should NOT throw — delegates are collected before cleanup.
        const delegates = taskFlowConsumePendingDelegates("test-session");

        expect(delegates).toHaveLength(3);
        expect(delegates[0].task).toBe("task 1");
        expect(delegates[1].task).toBe("task 2");
        expect(delegates[2].task).toBe("task 3");

        // The failed finishFlow should have been logged as a warning.
        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy.mock.calls[0][0]).toContain("simulated SQLite failure");
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  it("completed/cancelled records are excluded from pending listings", async () => {
    await withFlowRegistryTempDir(async () => {
      taskFlowEnqueuePendingDelegate("test-session", { task: "will complete" });
      taskFlowEnqueuePendingDelegate("test-session", { task: "will cancel" });
      taskFlowEnqueuePendingDelegate("test-session", { task: "stays queued" });

      // Consume first delegate (→ succeeded).
      const consumed = taskFlowConsumePendingDelegates("test-session");
      expect(consumed).toHaveLength(3);

      // Re-enqueue one to have a pending record.
      taskFlowEnqueuePendingDelegate("test-session", { task: "new pending" });

      // Only the new pending delegate is visible.
      expect(taskFlowPendingDelegateCount("test-session")).toBe(1);
      const delegates = taskFlowConsumePendingDelegates("test-session");
      expect(delegates).toHaveLength(1);
      expect(delegates[0].task).toBe("new pending");

      // All records still exist in the registry (succeeded + new succeeded).
      const allFlows = listTaskFlowsForOwnerKey("test-session");
      expect(allFlows.length).toBe(4);
    });
  });
});

describe("config-gated delegate store routing", () => {
  beforeEach(() => {
    vi.useRealTimers();
    setTaskFlowDelegatesEnabled(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    setTaskFlowDelegatesEnabled(false);
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
    resetTaskFlowRegistryForTests();
  });

  it("defaults to volatile store when taskFlowDelegates is disabled", () => {
    expect(isTaskFlowDelegatesEnabled()).toBe(false);

    enqueuePendingDelegate("test-session", { task: "volatile task" });
    expect(pendingDelegateCount("test-session")).toBe(1);

    const delegates = consumePendingDelegates("test-session");
    expect(delegates).toHaveLength(1);
    expect(delegates[0].task).toBe("volatile task");
  });

  it("routes through TaskFlow store when enabled", async () => {
    await withFlowRegistryTempDir(async () => {
      setTaskFlowDelegatesEnabled(true);

      enqueuePendingDelegate("test-session", { task: "taskflow task", delayMs: 1000 });
      expect(pendingDelegateCount("test-session")).toBe(1);

      const delegates = consumePendingDelegates("test-session");
      expect(delegates).toHaveLength(1);
      expect(delegates[0].task).toBe("taskflow task");
      expect(delegates[0].delayMs).toBe(1000);
    });
  });

  it("cancelPendingDelegates works for volatile store", () => {
    enqueuePendingDelegate("test-session", { task: "will be cancelled" });
    expect(pendingDelegateCount("test-session")).toBe(1);

    cancelPendingDelegates("test-session");
    expect(pendingDelegateCount("test-session")).toBe(0);
  });

  it("cancelPendingDelegates routes to TaskFlow when enabled", async () => {
    await withFlowRegistryTempDir(async () => {
      setTaskFlowDelegatesEnabled(true);

      enqueuePendingDelegate("test-session", { task: "will be cancelled" });
      expect(pendingDelegateCount("test-session")).toBe(1);

      cancelPendingDelegates("test-session");
      expect(pendingDelegateCount("test-session")).toBe(0);
    });
  });

  it("volatile and TaskFlow stores are independent (migration scenario)", async () => {
    // Stage a volatile delegate with TaskFlow disabled.
    enqueuePendingDelegate("test-session", { task: "volatile delegate" });
    expect(pendingDelegateCount("test-session")).toBe(1);

    await withFlowRegistryTempDir(async () => {
      // Enable TaskFlow — volatile delegate is invisible to TaskFlow.
      setTaskFlowDelegatesEnabled(true);
      expect(pendingDelegateCount("test-session")).toBe(0);

      // Enqueue a TaskFlow delegate.
      enqueuePendingDelegate("test-session", { task: "taskflow delegate" });
      expect(pendingDelegateCount("test-session")).toBe(1);

      // Disable TaskFlow — volatile delegate reappears.
      setTaskFlowDelegatesEnabled(false);
      expect(pendingDelegateCount("test-session")).toBe(1);

      const volatile = consumePendingDelegates("test-session");
      expect(volatile).toHaveLength(1);
      expect(volatile[0].task).toBe("volatile delegate");

      // Re-enable — TaskFlow delegate is still there.
      setTaskFlowDelegatesEnabled(true);
      const taskflow = consumePendingDelegates("test-session");
      expect(taskflow).toHaveLength(1);
      expect(taskflow[0].task).toBe("taskflow delegate");
    });
  });
});
