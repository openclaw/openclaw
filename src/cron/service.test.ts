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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-cron-"));
  return {
    storePath: path.join(dir, "cron.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("CronService", () => {
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

  it("runs a one-shot main job and disables it after success", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestReplyHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestReplyHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:02.000Z");
    const job = await cron.add({
      enabled: true,
      schedule: { kind: "at", atMs },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });

    expect(job.state.nextRunAtMs).toBe(atMs);

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated?.enabled).toBe(false);
    expect(enqueueSystemEvent).toHaveBeenCalledWith("hello");
    expect(requestReplyHeartbeatNow).toHaveBeenCalled();

    await cron.list({ includeDisabled: true });
    cron.stop();
    await store.cleanup();
  });

  it("runs an isolated job and posts summary to main", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestReplyHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestReplyHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cron.add({
      enabled: true,
      name: "weekly",
      schedule: { kind: "at", atMs },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it", deliver: false },
    });

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();

    await cron.list({ includeDisabled: true });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith("Cron: done");
    expect(requestReplyHeartbeatNow).toHaveBeenCalled();
    cron.stop();
    await store.cleanup();
  });

  it("posts last output to main even when isolated job errors", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestReplyHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "boom",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestReplyHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cron.add({
      enabled: true,
      schedule: { kind: "at", atMs },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it", deliver: false },
    });

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "Cron (error): last output",
    );
    expect(requestReplyHeartbeatNow).toHaveBeenCalled();
    cron.stop();
    await store.cleanup();
  });

  it("rejects unsupported session/payload combinations", async () => {
    const store = await makeStorePath();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestReplyHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    await expect(
      cron.add({
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "nope" },
      }),
    ).rejects.toThrow(/main cron jobs require/);

    await expect(
      cron.add({
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "nope" },
      }),
    ).rejects.toThrow(/isolated cron jobs require/);

    cron.stop();
    await store.cleanup();
  });

  it("skips invalid main jobs with agentTurn payloads from disk", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestReplyHeartbeatNow = vi.fn();

    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await fs.writeFile(
      store.storePath,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "job-1",
            enabled: true,
            createdAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
            updatedAtMs: Date.parse("2025-12-13T00:00:00.000Z"),
            schedule: { kind: "at", atMs },
            sessionTarget: "main",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "bad" },
            state: {},
          },
        ],
      }),
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestReplyHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestReplyHeartbeatNow).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs[0]?.state.lastStatus).toBe("skipped");
    expect(jobs[0]?.state.lastError).toMatch(/main job requires/i);

    cron.stop();
    await store.cleanup();
  });

  it("skips main jobs with empty systemEvent text", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestReplyHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestReplyHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cron.add({
      enabled: true,
      schedule: { kind: "at", atMs },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "   " },
    });

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestReplyHeartbeatNow).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs[0]?.state.lastStatus).toBe("skipped");
    expect(jobs[0]?.state.lastError).toMatch(/non-empty/i);

    cron.stop();
    await store.cleanup();
  });

  it("does not schedule timers when cron is disabled", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestReplyHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: false,
      log: noopLogger,
      enqueueSystemEvent,
      requestReplyHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cron.add({
      enabled: true,
      schedule: { kind: "at", atMs },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });

    const status = await cron.status();
    expect(status.enabled).toBe(false);
    expect(status.nextWakeAtMs).toBeNull();

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestReplyHeartbeatNow).not.toHaveBeenCalled();
    expect(noopLogger.warn).toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("status reports next wake when enabled", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestReplyHeartbeatNow = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestReplyHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:05.000Z");
    await cron.add({
      enabled: true,
      schedule: { kind: "at", atMs },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });

    const status = await cron.status();
    expect(status.enabled).toBe(true);
    expect(status.jobs).toBe(1);
    expect(status.nextWakeAtMs).toBe(atMs);

    cron.stop();
    await store.cleanup();
  });
});
