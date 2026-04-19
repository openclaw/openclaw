import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-skip-when-idle",
});

function createMainJobWithSkipWhenIdle(params: {
  now: number;
  skipWhenIdle?: CronJob["skipWhenIdle"];
}): CronJob {
  return {
    id: "idle-check-job",
    name: "idle check job",
    enabled: true,
    createdAtMs: params.now - 120_000,
    updatedAtMs: params.now - 120_000,
    schedule: { kind: "every", everyMs: 60_000, anchorMs: params.now - 60_000 },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "idle check tick" },
    skipWhenIdle: params.skipWhenIdle,
    state: { nextRunAtMs: params.now - 1 },
  };
}

describe("skipWhenIdle", () => {
  it("skips job when session has been idle longer than idleMs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const lastInbound = now - 45 * 60_000; // 45 min ago (idle > 30 min default)
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createMainJobWithSkipWhenIdle({ now, skipWhenIdle: { idleMs: 30 * 60_000 } })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      getLastInboundAtMs: () => lastInbound,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    // Job should have been skipped — no system event enqueued
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    expect(job).toBeDefined();
    expect(job?.state.lastRunStatus).toBe("skipped");
    expect(job?.state.lastError).toBe("session-idle");
    // Skipped runs should not increment consecutive errors
    expect(job?.state.consecutiveErrors).toBe(0);
  });

  it("runs job when session has been active within idleMs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const lastInbound = now - 10 * 60_000; // 10 min ago (< 30 min threshold)
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createMainJobWithSkipWhenIdle({ now, skipWhenIdle: { idleMs: 30 * 60_000 } })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      getLastInboundAtMs: () => lastInbound,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    // Job should have run — system event enqueued
    expect(enqueueSystemEvent).toHaveBeenCalledWith("idle check tick", {
      agentId: undefined,
      sessionKey: undefined,
      contextKey: "cron:idle-check-job",
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    expect(job?.state.lastRunStatus).toBe("ok");
  });

  it("runs job when skipWhenIdle is not set", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const lastInbound = now - 45 * 60_000; // 45 min ago, but skipWhenIdle is not set
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createMainJobWithSkipWhenIdle({ now, skipWhenIdle: undefined })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      getLastInboundAtMs: () => lastInbound,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    // Job should run regardless of idle state
    expect(enqueueSystemEvent).toHaveBeenCalledWith("idle check tick", {
      agentId: undefined,
      sessionKey: undefined,
      contextKey: "cron:idle-check-job",
    });
  });

  it("runs job when skipWhenIdle is explicitly false", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const lastInbound = now - 45 * 60_000;
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createMainJobWithSkipWhenIdle({ now, skipWhenIdle: false })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      getLastInboundAtMs: () => lastInbound,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    // Job should run — skipWhenIdle is explicitly disabled
    expect(enqueueSystemEvent).toHaveBeenCalled();
  });

  it("uses default 30min idleMs when skipWhenIdle has no idleMs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    // 25 min ago — within the 30 min default
    const lastInbound = now - 25 * 60_000;
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createMainJobWithSkipWhenIdle({ now, skipWhenIdle: {} })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      getLastInboundAtMs: () => lastInbound,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    // 25 min idle < 30 min default → should run
    expect(enqueueSystemEvent).toHaveBeenCalled();
  });

  it("skips with default 30min idleMs when idle exceeds default", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    // 35 min ago — exceeds the 30 min default
    const lastInbound = now - 35 * 60_000;
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createMainJobWithSkipWhenIdle({ now, skipWhenIdle: {} })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      getLastInboundAtMs: () => lastInbound,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    // 35 min idle > 30 min default → should skip
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("skips when getLastInboundAtMs is not provided (no activity data)", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createMainJobWithSkipWhenIdle({ now, skipWhenIdle: { idleMs: 30 * 60_000 } })],
    });

    // No getLastInboundAtMs provided
    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    // Should skip — no activity data means we assume idle
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("skips when getLastInboundAtMs returns undefined", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createMainJobWithSkipWhenIdle({ now, skipWhenIdle: { idleMs: 30 * 60_000 } })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      getLastInboundAtMs: () => undefined,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    // Should skip — undefined means no activity known
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("does not skip one-shot 'at' jobs even when session is idle", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    const lastInbound = now - 45 * 60_000; // 45 min ago (idle > 30 min)
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const atJob: CronJob = {
      id: "one-shot-at-job",
      name: "one-shot reminder",
      enabled: true,
      createdAtMs: now - 120_000,
      updatedAtMs: now - 120_000,
      schedule: { kind: "at", at: new Date(now - 1).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "one-shot reminder text" },
      skipWhenIdle: { idleMs: 30 * 60_000 },
      state: { nextRunAtMs: now - 1 },
    };

    await writeCronStoreSnapshot({ storePath, jobs: [atJob] });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      getLastInboundAtMs: () => lastInbound,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    // One-shot 'at' job should run despite idle session
    expect(enqueueSystemEvent).toHaveBeenCalledWith("one-shot reminder text", {
      agentId: undefined,
      sessionKey: undefined,
      contextKey: "cron:one-shot-at-job",
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      jobs: CronJob[];
    };
    const job = persisted.jobs[0];
    expect(job?.state.lastRunStatus).toBe("ok");
    // Job should be disabled after successful one-shot run, not permanently
    // killed by an idle skip.
    expect(job?.enabled).toBe(false);
  });

  it("respects custom idleMs value", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.parse("2026-03-23T12:00:00.000Z");
    // 8 min ago — within 10 min custom threshold
    const lastInbound = now - 8 * 60_000;
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeCronStoreSnapshot({
      storePath,
      jobs: [createMainJobWithSkipWhenIdle({ now, skipWhenIdle: { idleMs: 10 * 60_000 } })],
    });

    const state = createCronServiceState({
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => now,
      enqueueSystemEvent,
      requestHeartbeatNow,
      getLastInboundAtMs: () => lastInbound,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    await onTimer(state);

    // 8 min idle < 10 min custom → should run
    expect(enqueueSystemEvent).toHaveBeenCalled();
  });
});
