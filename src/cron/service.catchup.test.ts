import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./types.js";
import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-catchup-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

async function writeStore(storePath: string, jobs: unknown[]) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify({ version: 1, jobs }, null, 2),
    "utf-8",
  );
}

describe("CronService catch-up for missed jobs", () => {
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

  it("logs missed job and runs it when catchUp is not enabled", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const baseMs = Date.parse("2025-12-13T00:00:00.000Z");

    // Job was due 5 minutes ago
    await writeStore(store.storePath, [
      {
        id: "missed-no-catchup",
        name: "missed job",
        enabled: true,
        createdAtMs: baseMs - 600_000,
        updatedAtMs: baseMs - 600_000,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: baseMs - 600_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        state: { nextRunAtMs: baseMs - 300_000 },
      },
    ]);

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    // Job should have been run once on startup
    expect(enqueueSystemEvent).toHaveBeenCalledWith("hello", { agentId: undefined });

    const jobs = await cron.list({ includeDisabled: true });
    const job = jobs.find((j) => j.id === "missed-no-catchup");
    expect(job?.state.lastStatus).toBe("ok");

    cron.stop();
    await store.cleanup();
  });

  it("catches up missed job with strategy 'once' (default)", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const baseMs = Date.parse("2025-12-13T00:00:00.000Z");

    // Job was due 5 minutes ago, catchUp enabled
    await writeStore(store.storePath, [
      {
        id: "catchup-once",
        name: "catchup once job",
        enabled: true,
        createdAtMs: baseMs - 600_000,
        updatedAtMs: baseMs - 600_000,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: baseMs - 600_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "catch-once" },
        catchUp: { enabled: true, strategy: "once" },
        state: { nextRunAtMs: baseMs - 300_000 },
      },
    ]);

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    // Should fire exactly once despite multiple missed occurrences
    const calls = enqueueSystemEvent.mock.calls.filter((args) => args[0] === "catch-once");
    expect(calls.length).toBe(1);

    cron.stop();
    await store.cleanup();
  });

  it("catches up all missed occurrences with strategy 'all'", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const baseMs = Date.parse("2025-12-13T00:00:00.000Z");

    // Job with 60s interval, missed by 5 minutes = ~5 missed occurrences
    await writeStore(store.storePath, [
      {
        id: "catchup-all",
        name: "catchup all job",
        enabled: true,
        createdAtMs: baseMs - 600_000,
        updatedAtMs: baseMs - 600_000,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: baseMs - 600_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "catch-all" },
        catchUp: { enabled: true, strategy: "all" },
        state: { nextRunAtMs: baseMs - 300_000 },
      },
    ]);

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    // Should fire multiple times (one per missed occurrence)
    const calls = enqueueSystemEvent.mock.calls.filter((args) => args[0] === "catch-all");
    expect(calls.length).toBeGreaterThan(1);

    cron.stop();
    await store.cleanup();
  });

  it("skips catch-up when missed time exceeds maxDelayMs", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const baseMs = Date.parse("2025-12-13T00:00:00.000Z");

    // Job missed by 5 minutes, but maxDelayMs is only 2 minutes
    await writeStore(store.storePath, [
      {
        id: "catchup-expired",
        name: "expired catchup job",
        enabled: true,
        createdAtMs: baseMs - 600_000,
        updatedAtMs: baseMs - 600_000,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: baseMs - 600_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "expired" },
        catchUp: { enabled: true, maxDelayMs: 120_000 },
        state: { nextRunAtMs: baseMs - 300_000 },
      },
    ]);

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    // Should NOT fire — exceeded maxDelayMs
    const calls = enqueueSystemEvent.mock.calls.filter((args) => args[0] === "expired");
    expect(calls.length).toBe(0);

    // Should have logged a warning
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "catchup-expired" }),
      expect.stringContaining("maxDelayMs"),
    );

    cron.stop();
    await store.cleanup();
  });

  it("recomputes nextRunAtMs after catch-up", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const baseMs = Date.parse("2025-12-13T00:00:00.000Z");

    await writeStore(store.storePath, [
      {
        id: "catchup-recompute",
        name: "recompute job",
        enabled: true,
        createdAtMs: baseMs - 600_000,
        updatedAtMs: baseMs - 600_000,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: baseMs - 600_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "recompute" },
        catchUp: { enabled: true },
        state: { nextRunAtMs: baseMs - 300_000 },
      },
    ]);

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    const jobs = await cron.list({ includeDisabled: true });
    const job = jobs.find((j) => j.id === "catchup-recompute");
    // nextRunAtMs should be in the future now
    expect(job?.state.nextRunAtMs).toBeGreaterThanOrEqual(baseMs);

    cron.stop();
    await store.cleanup();
  });
});
