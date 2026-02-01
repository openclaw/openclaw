import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("CronService stale running marker recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T02:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears stale runningAtMs and records an error status", async () => {
    const store = await makeStorePath();

    const nowMs = Date.parse("2025-12-13T02:00:00.000Z");
    // jobs.ts uses a 2-hour stale threshold; set runningAt older than that.
    const runningAtMs = nowMs - 2 * 60 * 60 * 1000 - 1;

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "job-stale",
              name: "stale run",
              enabled: true,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "main",
              wakeMode: "next-heartbeat",
              payload: { kind: "systemEvent", text: "hello" },
              state: {
                runningAtMs,
                nextRunAtMs: nowMs - 10_000,
              },
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    const jobs = await cron.list({ includeDisabled: true });
    const job = jobs.find((j) => j.id === "job-stale");

    expect(job?.state.runningAtMs).toBeUndefined();
    expect(job?.state.lastStatus).toBe("error");
    expect(job?.state.lastRunAtMs).toBe(runningAtMs);
    expect(job?.state.lastDurationMs).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
    expect(job?.state.lastError).toMatch(/Recovered from stale running state/i);

    cron.stop();
    await store.cleanup();
  });
});
