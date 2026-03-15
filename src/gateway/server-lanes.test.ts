import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueueCommandInLane, resetAllLanes } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("applyGatewayLaneConcurrency", () => {
  beforeEach(() => {
    resetAllLanes();
  });

  it("keeps the cron nested lane concurrency aligned with cron.maxConcurrentRuns", async () => {
    applyGatewayLaneConcurrency({
      cron: { maxConcurrentRuns: 2 },
    } as unknown as ReturnType<typeof import("../config/config.js").loadConfig>);

    const blocker = createDeferred();
    let started = 0;

    const runTask = () =>
      enqueueCommandInLane(CommandLane.CronNested, async () => {
        started += 1;
        await blocker.promise;
      });

    const first = runTask();
    const second = runTask();

    try {
      await vi.waitFor(() => {
        expect(started).toBe(2);
      });
    } finally {
      blocker.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it("keeps the shared interactive nested lane at its default concurrency", async () => {
    applyGatewayLaneConcurrency({
      cron: { maxConcurrentRuns: 2 },
    } as unknown as ReturnType<typeof import("../config/config.js").loadConfig>);

    const blocker = createDeferred();
    let started = 0;

    const runTask = () =>
      enqueueCommandInLane(CommandLane.Nested, async () => {
        started += 1;
        await blocker.promise;
      });

    const first = runTask();
    const second = runTask();

    try {
      await vi.waitFor(() => {
        expect(started).toBe(1);
      });
    } finally {
      blocker.resolve();
      await Promise.allSettled([first, second]);
    }
  });
});
