import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService restart catch-up", () => {
  async function writeStoreJobs(storePath: string, jobs: unknown[]) {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2), "utf-8");
  }

  function createRestartCronService(params: {
    storePath: string;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeatNow: ReturnType<typeof vi.fn>;
  }) {
    return new CronService({
      storePath: params.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: params.enqueueSystemEvent as never,
      requestHeartbeatNow: params.requestHeartbeatNow as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
    });
  }

  it("executes an overdue recurring job immediately on start", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const dueAt = Date.parse("2025-12-13T15:00:00.000Z");
    const lastRunAt = Date.parse("2025-12-12T15:00:00.000Z");

    await writeStoreJobs(store.storePath, [
      {
        id: "restart-overdue-job",
        name: "daily digest",
        enabled: true,
        createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
        updatedAtMs: Date.parse("2025-12-12T15:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 15 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "digest now" },
        state: {
          nextRunAtMs: dueAt,
          lastRunAtMs: lastRunAt,
          lastStatus: "ok",
        },
      },
    ]);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeatNow,
    });

    await cron.start();

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "digest now",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(requestHeartbeatNow).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((job) => job.id === "restart-overdue-job");
    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T17:00:00.000Z"));
    expect(updated?.state.nextRunAtMs).toBeGreaterThan(Date.parse("2025-12-13T17:00:00.000Z"));

    cron.stop();
    await store.cleanup();
  });

  it("clears stale running markers without replaying interrupted startup jobs", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const dueAt = Date.parse("2025-12-13T16:00:00.000Z");
    const staleRunningAt = Date.parse("2025-12-13T16:30:00.000Z");

    await writeStoreJobs(store.storePath, [
      {
        id: "restart-stale-running",
        name: "daily stale marker",
        enabled: true,
        createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
        updatedAtMs: Date.parse("2025-12-13T16:30:00.000Z"),
        schedule: { kind: "cron", expr: "0 16 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "resume stale marker" },
        state: {
          nextRunAtMs: dueAt,
          runningAtMs: staleRunningAt,
        },
      },
    ]);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeatNow,
    });

    await cron.start();

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "restart-stale-running" }),
      "cron: clearing stale running marker on startup",
    );

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((job) => job.id === "restart-stale-running");
    expect(updated?.state.runningAtMs).toBeUndefined();
    expect(updated?.state.lastStatus).toBeUndefined();
    expect(updated?.state.lastRunAtMs).toBeUndefined();
    expect((updated?.state.nextRunAtMs ?? 0) > Date.parse("2025-12-13T17:00:00.000Z")).toBe(true);

    cron.stop();
    await store.cleanup();
  });
  it("replays the most recent missed cron slot after restart when nextRunAtMs already advanced", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeStoreJobs(store.storePath, [
      {
        id: "restart-missed-slot",
        name: "every ten minutes +1",
        enabled: true,
        createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
        updatedAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
        schedule: { kind: "cron", expr: "1,11,21,31,41,51 4-20 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "catch missed slot" },
        state: {
          // Persisted state may already be recomputed from restart time and
          // point to the future slot, even though 04:01 was missed.
          nextRunAtMs: Date.parse("2025-12-13T04:11:00.000Z"),
          lastRunAtMs: Date.parse("2025-12-13T03:51:00.000Z"),
          lastStatus: "ok",
        },
      },
    ]);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeatNow,
    });

    await cron.start();

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "catch missed slot",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(requestHeartbeatNow).toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((job) => job.id === "restart-missed-slot");
    expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T04:02:00.000Z"));

    cron.stop();
    await store.cleanup();
  });

  it("does not replay interrupted one-shot jobs on startup", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const dueAt = Date.parse("2025-12-13T16:00:00.000Z");
    const staleRunningAt = Date.parse("2025-12-13T16:30:00.000Z");

    await writeStoreJobs(store.storePath, [
      {
        id: "restart-stale-one-shot",
        name: "one shot stale marker",
        enabled: true,
        createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
        updatedAtMs: Date.parse("2025-12-13T16:30:00.000Z"),
        schedule: { kind: "at", at: "2025-12-13T16:00:00.000Z" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "one-shot stale marker" },
        state: {
          nextRunAtMs: dueAt,
          runningAtMs: staleRunningAt,
        },
      },
    ]);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeatNow,
    });

    await cron.start();

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((job) => job.id === "restart-stale-one-shot");
    expect(updated?.state.runningAtMs).toBeUndefined();

    cron.stop();
    await store.cleanup();
  });

  it("does not replay cron slot when the latest slot already ran before restart", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeStoreJobs(store.storePath, [
      {
        id: "restart-no-duplicate-slot",
        name: "every ten minutes +1 no duplicate",
        enabled: true,
        createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
        updatedAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
        schedule: { kind: "cron", expr: "1,11,21,31,41,51 4-20 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "already ran" },
        state: {
          nextRunAtMs: Date.parse("2025-12-13T04:11:00.000Z"),
          lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
          lastStatus: "ok",
        },
      },
    ]);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeatNow,
    });

    await cron.start();

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    cron.stop();
    await store.cleanup();
  });

  it("does not replay missed cron slots while error backoff is pending after restart", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeStoreJobs(store.storePath, [
      {
        id: "restart-backoff-pending",
        name: "backoff pending",
        enabled: true,
        createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
        updatedAtMs: Date.parse("2025-12-13T04:01:10.000Z"),
        schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "do not run during backoff" },
        state: {
          // Next retry is intentionally delayed by backoff despite a newer cron slot.
          nextRunAtMs: Date.parse("2025-12-13T04:10:00.000Z"),
          lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
          lastStatus: "error",
          consecutiveErrors: 4,
        },
      },
    ]);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeatNow,
    });

    await cron.start();

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("replays missed cron slot after restart when error backoff has already elapsed", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeStoreJobs(store.storePath, [
      {
        id: "restart-backoff-elapsed-replay",
        name: "backoff elapsed replay",
        enabled: true,
        createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
        updatedAtMs: Date.parse("2025-12-13T04:01:10.000Z"),
        schedule: { kind: "cron", expr: "1,11,21,31,41,51 4-20 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "replay after backoff elapsed" },
        state: {
          // Startup maintenance may already point to a future slot (04:11) even
          // though 04:01 was missed and the 30s error backoff has elapsed.
          nextRunAtMs: Date.parse("2025-12-13T04:11:00.000Z"),
          lastRunAtMs: Date.parse("2025-12-13T03:51:00.000Z"),
          lastStatus: "error",
          consecutiveErrors: 1,
        },
      },
    ]);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeatNow,
    });

    await cron.start();

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      "replay after backoff elapsed",
      expect.objectContaining({ agentId: undefined }),
    );
    expect(requestHeartbeatNow).toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });
});
