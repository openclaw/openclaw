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

describe("CronService interval/cron jobs fire on time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires an every-type main job when the timer fires a few ms late", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const job = await cron.add({
      name: "every 10s check",
      enabled: true,
      schedule: { kind: "every", everyMs: 10_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "tick" },
    });

    const firstDueAt = job.state.nextRunAtMs!;
    expect(firstDueAt).toBe(Date.parse("2025-12-13T00:00:00.000Z") + 10_000);

    // Simulate setTimeout firing 5ms late (the race condition).
    vi.setSystemTime(new Date(firstDueAt + 5));
    await vi.runOnlyPendingTimersAsync();

    // Wait for the async onTimer to complete via the lock queue.
    const jobs = await cron.list();
    const updated = jobs.find((j) => j.id === job.id);

    expect(enqueueSystemEvent).toHaveBeenCalledWith("tick", { agentId: undefined });
    expect(updated?.state.lastStatus).toBe("ok");
    // nextRunAtMs must advance by at least one full interval past the due time.
    expect(updated?.state.nextRunAtMs).toBeGreaterThanOrEqual(firstDueAt + 10_000);

    cron.stop();
    await store.cleanup();
  });

  it("fires a cron-expression job when the timer fires a few ms late", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    // Set time to just before a minute boundary.
    vi.setSystemTime(new Date("2025-12-13T00:00:59.000Z"));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const job = await cron.add({
      name: "every minute check",
      enabled: true,
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "cron-tick" },
    });

    const firstDueAt = job.state.nextRunAtMs!;

    // Simulate setTimeout firing 5ms late.
    vi.setSystemTime(new Date(firstDueAt + 5));
    await vi.runOnlyPendingTimersAsync();

    // Wait for the async onTimer to complete via the lock queue.
    const jobs = await cron.list();
    const updated = jobs.find((j) => j.id === job.id);

    expect(enqueueSystemEvent).toHaveBeenCalledWith("cron-tick", { agentId: undefined });
    expect(updated?.state.lastStatus).toBe("ok");
    // nextRunAtMs should be the next whole-minute boundary (60s later).
    expect(updated?.state.nextRunAtMs).toBe(firstDueAt + 60_000);

    cron.stop();
    await store.cleanup();
  });
});
