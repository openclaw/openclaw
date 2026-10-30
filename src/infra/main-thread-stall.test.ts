import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createMainThreadStallMonitor,
  getMainThreadTaskName,
  runWithMainThreadTask,
} from "./main-thread-stall.js";

const monitors: ReturnType<typeof createMainThreadStallMonitor>[] = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) {
    monitor.stop();
  }
  vi.useRealTimers();
});

const emptyReport = { stalls: [], dropped: 0, unattributedDropped: 0, delayMaxMs: 0 };

function fixture() {
  let now = 0;
  const monitor = createMainThreadStallMonitor(() => now);
  monitors.push(monitor);
  return { monitor, elapse: (milliseconds: number) => (now += milliseconds) };
}

describe("main-thread stall attribution", () => {
  it("copies the task context only on label changes and preserves nested timing segments", () => {
    const { monitor, elapse } = fixture();
    const enter = vi.spyOn(AsyncLocalStorage.prototype, "enterWith");
    const copyOnReturn = vi.spyOn(AsyncLocalStorage.prototype, "run");
    try {
      runWithMainThreadTask("worker:control-decode", () => {
        elapse(200);
        runWithMainThreadTask("worker:control-decode", () => elapse(100));
        elapse(200);
      });
      const entries = enter.mock.calls.slice();
      expect(getMainThreadTaskName()).toBeUndefined();
      expect(monitor.drain().stalls).toEqual([
        {
          elapsedMs: 500,
          task: "worker:control-decode",
          taskMs: 200,
          startedAt: 0,
          endedAt: 500,
        },
      ]);
      expect(copyOnReturn).not.toHaveBeenCalled();
      expect(entries).toEqual([["worker:control-decode"]]);
    } finally {
      copyOnReturn.mockRestore();
      enter.mockRestore();
    }
  });

  it("does not retain the request context that enables heartbeat sampling", async () => {
    const request = new AsyncLocalStorage<string>();
    const observed: (string | undefined)[] = [];
    const monitor = createMainThreadStallMonitor(() => {
      observed.push(request.getStore());
      return performance.now();
    });
    monitors.push(monitor);
    request.run("request-context", () => monitor.setEventLoopSampling(true));
    observed.length = 0;
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    monitor.stop();
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((context) => context === undefined)).toBe(true);
  });

  it("retains an observed blocked-loop interval while unrelated work runs before reporting", () => {
    vi.useFakeTimers();
    const { monitor, elapse } = fixture();
    monitor.setEventLoopSampling(true);
    elapse(25);
    vi.advanceTimersByTime(25);
    elapse(1_200);
    vi.advanceTimersByTime(25);
    elapse(500);
    expect(monitor.drain().stalls).toEqual([
      { task: "unattributed", taskMs: 1_200, elapsedMs: 1_200, startedAt: 25, endedAt: 1_225 },
    ]);
    monitor.setEventLoopSampling(false);
    elapse(10_000);
    vi.advanceTimersByTime(25);
    monitor.setEventLoopSampling(true);
    expect(monitor.drain().stalls).toEqual([]);
  });

  it("deduplicates only overlapping scoped stalls, including when the health timer resumes first", () => {
    vi.useFakeTimers();
    const { monitor, elapse } = fixture();
    monitor.setEventLoopSampling(true);
    runWithMainThreadTask("scoped", () => elapse(1_200));
    expect(monitor.drain().stalls).toEqual([
      { task: "scoped", taskMs: 1_200, elapsedMs: 1_200, startedAt: 0, endedAt: 1_200 },
    ]);
    elapse(1_200);
    vi.advanceTimersByTime(25);
    runWithMainThreadTask("later", () => elapse(300));
    expect(monitor.drain().stalls).toEqual([
      { task: "unattributed", taskMs: 1_200, elapsedMs: 1_200, startedAt: 1_200, endedAt: 2_400 },
      { task: "later", taskMs: 300, elapsedMs: 300, startedAt: 2_400, endedAt: 2_700 },
    ]);
  });

  it("reports callbacks at the 250 ms boundary, excluding shorter work and async waits", async () => {
    const { monitor, elapse } = fixture();
    runWithMainThreadTask("scheduler:short", () => elapse(249));
    await runWithMainThreadTask("gateway:rpc:sessions.list", async () => {
      elapse(250);
      await Promise.resolve();
      elapse(5_000);
    });
    expect(monitor.drain()).toMatchObject({
      stalls: [{ elapsedMs: 250, task: "gateway:rpc:sessions.list", taskMs: 250 }],
      dropped: 0,
      delayMaxMs: 250,
    });
  });

  it("keeps unattributed overflow out of the scoped-stall drop count", () => {
    vi.useFakeTimers();
    const { monitor, elapse } = fixture();
    monitor.setEventLoopSampling(true);
    for (let index = 0; index < 8; index++) {
      runWithMainThreadTask("scoped", () => elapse(250));
    }
    const report = monitor.drain();
    expect(report.stalls).toHaveLength(8);
    expect(report.dropped).toBe(0);
    expect(report.unattributedDropped).toBe(1);
    expect(monitor.drain().unattributedDropped).toBe(0);
  });

  it("records one stall naming the blocking nested task, then consumes it once", () => {
    const { monitor, elapse } = fixture();
    runWithMainThreadTask("maintenance", () => {
      elapse(10);
      runWithMainThreadTask("transcript-index", () => elapse(1_200));
      elapse(10);
    });
    expect(monitor.drain()).toMatchObject({
      stalls: [{ elapsedMs: 1_220, task: "transcript-index", taskMs: 1_200 }],
      dropped: 0,
      delayMaxMs: 1_220,
    });
    expect(monitor.drain()).toEqual(emptyReport);
  });

  it("returns the original promise without observing its continuations", async () => {
    const { monitor, elapse } = fixture();
    const ready = createDeferredCore();
    const operation = ready.promise.then(() => elapse(1_200));
    expect(runWithMainThreadTask("maintenance:resume", () => operation)).toBe(operation);
    elapse(5_000);
    ready.resolve();
    await operation;
    expect(monitor.drain()).toEqual(emptyReport);
  });

  it("restores same-name phases after nested work throws", () => {
    const { monitor, elapse } = fixture();
    const task = "gateway:rpc:sessions.list";
    const failed = new Error("row preparation failed");
    runWithMainThreadTask(task, () => {
      runWithMainThreadTask(
        task,
        () => {
          elapse(10);
          expect(() =>
            runWithMainThreadTask(
              task,
              () => {
                expect(getMainThreadTaskName()).toBe(task);
                elapse(300);
                throw failed;
              },
              "agent-roster",
            ),
          ).toThrow(failed);
          expect(getMainThreadTaskName()).toBe(task);
          elapse(400);
        },
        "session-rows:select",
      );
    });
    expect(getMainThreadTaskName()).toBeUndefined();
    expect(monitor.drain()).toMatchObject({
      stalls: [{ elapsedMs: 710, task: `${task}:session-rows:select`, taskMs: 400 }],
      dropped: 0,
      delayMaxMs: 710,
    });
  });

  it("keeps overlapping callers across waits and synchronous owner-context reentry", async () => {
    const { monitor, elapse } = fixture();
    const ownerContext = AsyncLocalStorage.snapshot();
    const ready = createDeferredCore();
    const first = runWithMainThreadTask("gateway:rpc:sessions.list", async () => {
      await ready.promise;
      expect(getMainThreadTaskName()).toBe("gateway:rpc:sessions.list");
      runWithMainThreadTask(
        getMainThreadTaskName()!,
        () => {
          ownerContext(() => {
            expect(getMainThreadTaskName()).toBe("gateway:rpc:sessions.list");
            elapse(300);
          });
        },
        "session-rows:select",
      );
      await Promise.resolve();
      expect(getMainThreadTaskName()).toBe("gateway:rpc:sessions.list");
    });
    await runWithMainThreadTask("scheduler:maintenance:refresh", async () => {
      await Promise.resolve();
      runWithMainThreadTask(getMainThreadTaskName()!, () => elapse(400), "agent-roster");
      ready.resolve();
    });
    await first;
    expect(getMainThreadTaskName()).toBeUndefined();
    expect(monitor.drain().stalls).toMatchObject([
      { elapsedMs: 400, task: "scheduler:maintenance:refresh:agent-roster", taskMs: 400 },
      { elapsedMs: 300, task: "gateway:rpc:sessions.list:session-rows:select", taskMs: 300 },
    ]);
  });

  it("starts a fresh observation when reset interrupts an active callback", () => {
    const { monitor, elapse } = fixture();
    runWithMainThreadTask("maintenance", () => elapse(1_200));
    runWithMainThreadTask("host-thaw", () => {
      elapse(90_000);
      monitor.reset();
      elapse(20);
    });
    expect(monitor.drain()).toEqual({ ...emptyReport, delayMaxMs: 20 });
  });

  it("bounds retained stalls and releases observation with the Gateway lifetime", () => {
    const { monitor, elapse } = fixture();
    for (let index = 0; index < 12; index++) {
      runWithMainThreadTask("maintenance", () => elapse(1_001));
    }
    const report = monitor.drain();
    expect(report.stalls).toHaveLength(8);
    expect(report.dropped).toBe(4);
    monitor.stop();
    runWithMainThreadTask("maintenance", () => elapse(1_001));
    expect(monitor.drain()).toEqual(emptyReport);
  });
});
