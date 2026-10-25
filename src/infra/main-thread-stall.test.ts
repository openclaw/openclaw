import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
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
});

function fixture() {
  let now = 0;
  const monitor = createMainThreadStallMonitor(() => now);
  monitors.push(monitor);
  return { monitor, elapse: (milliseconds: number) => (now += milliseconds) };
}

describe("main-thread stall attribution", () => {
  it("reports callbacks at the 250 ms boundary, excluding shorter work and async waits", async () => {
    const { monitor, elapse } = fixture();
    runWithMainThreadTask("scheduler:short", () => elapse(249));
    await runWithMainThreadTask("gateway:rpc:sessions.list", async () => {
      elapse(250);
      await Promise.resolve();
      elapse(5_000);
    });
    expect(monitor.drain()).toEqual({
      stalls: [{ elapsedMs: 250, task: "gateway:rpc:sessions.list", taskMs: 250 }],
      dropped: 0,
      delayMaxMs: 250,
    });
  });

  it("records one stall naming the blocking nested task, then consumes it once", () => {
    const { monitor, elapse } = fixture();
    runWithMainThreadTask("maintenance", () => {
      elapse(10);
      runWithMainThreadTask("transcript-index", () => elapse(1_200));
      elapse(10);
    });
    expect(monitor.drain()).toEqual({
      stalls: [{ elapsedMs: 1_220, task: "transcript-index", taskMs: 1_200 }],
      dropped: 0,
      delayMaxMs: 1_220,
    });
    expect(monitor.drain()).toEqual({ stalls: [], dropped: 0, delayMaxMs: 0 });
  });

  it("returns the original promise without observing its continuations", async () => {
    const { monitor, elapse } = fixture();
    const ready = createDeferredCore();
    const operation = ready.promise.then(() => elapse(1_200));
    expect(runWithMainThreadTask("maintenance:resume", () => operation)).toBe(operation);
    elapse(5_000);
    ready.resolve();
    await operation;
    expect(monitor.drain()).toEqual({ stalls: [], dropped: 0, delayMaxMs: 0 });
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
    expect(monitor.drain()).toEqual({
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
    expect(monitor.drain().stalls).toEqual([
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
    expect(monitor.drain()).toEqual({ stalls: [], dropped: 0, delayMaxMs: 20 });
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
    expect(monitor.drain()).toEqual({ stalls: [], dropped: 0, delayMaxMs: 0 });
  });
});
