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
