import { afterEach, describe, expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createMainThreadStallMonitor, runWithMainThreadTask } from "./main-thread-stall.js";

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
    });
    expect(monitor.drain()).toEqual({ stalls: [], dropped: 0 });
  });

  it("ignores time awaiting I/O and attributes a blocking continuation to its named owner", async () => {
    const { monitor, elapse } = fixture();
    const ready = createDeferredCore();
    const operation = runWithMainThreadTask("maintenance:resume", async () => {
      await ready.promise;
      elapse(1_200);
    });
    elapse(5_000);
    expect(monitor.drain()).toEqual({ stalls: [], dropped: 0 });
    ready.resolve();
    await operation;
    expect(monitor.drain()).toEqual({
      stalls: [{ elapsedMs: 1_200, task: "maintenance:resume", taskMs: 1_200 }],
      dropped: 0,
    });
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
    expect(monitor.drain()).toEqual({ stalls: [], dropped: 0 });
  });

  it.each(["sync", "resolved", "rejected"] as const)(
    "expires a %s task before its detached work runs",
    async (completion) => {
      const { monitor, elapse } = fixture();
      const ready = createDeferredCore();
      let detached: Promise<void> | undefined;
      const result = runWithMainThreadTask("plugins.runtime-post-bind", () => {
        detached = ready.promise.then(() => {
          elapse(1_700);
        });
        if (completion === "sync") {
          return undefined;
        }
        return completion === "resolved" ? Promise.resolve() : Promise.reject(new Error("load"));
      });
      if (completion === "rejected") {
        await expect(result).rejects.toThrow("load");
      } else {
        await result;
      }
      ready.resolve();
      await detached;
      expect(monitor.drain()).toEqual({
        stalls: [{ elapsedMs: 1_700, task: "unattributed", taskMs: 1_700 }],
        dropped: 0,
      });
    },
  );
});
