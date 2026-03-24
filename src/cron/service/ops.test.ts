import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "../service.test-harness.js";
import type { CronJob } from "../types.js";
import { start, stop } from "./ops.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-ops-seam",
});

function createInterruptedMainJob(now: number): CronJob {
  return {
    id: "startup-interrupted",
    name: "startup interrupted",
    enabled: true,
    createdAtMs: now - 86_400_000,
    updatedAtMs: now - 30 * 60_000,
    schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "should not replay on startup" },
    state: {
      nextRunAtMs: now - 60_000,
      runningAtMs: now - 30 * 60_000,
    },
  };
}

describe("cron service ops seam coverage", () => {
  it("start clears stale running markers, skips startup replay, persists, and arms the timer", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createInterruptedMainJob(now)],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await start(state);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "startup-interrupted" }),
      "cron: clearing stale running marker on startup",
    );
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    expect(state.timer).not.toBeNull();

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    expect(job).toBeDefined();
    expect(job?.state.runningAtMs).toBeUndefined();
    expect(job?.state.lastStatus).toBeUndefined();
    expect((job?.state.nextRunAtMs ?? 0) > now).toBe(true);

    const delays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === "number");
    expect(delays.some((delay) => delay > 0)).toBe(true);

    timeoutSpy.mockRestore();
    stop(state);
  });
});
