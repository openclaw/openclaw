import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import type { CronJob } from "./types.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

async function waitForJobs(cron: CronService, predicate: (jobs: CronJob[]) => boolean) {
  let latest: CronJob[] = [];
  for (let i = 0; i < 30; i++) {
    latest = await cron.list({ includeDisabled: true });
    if (predicate(latest)) {
      return latest;
    }
    await vi.runOnlyPendingTimersAsync();
  }
  return latest;
}

describe("CronService", () => {
  it("runs a one-shot main job and disables it after success when requested", async () => {
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
    const atMs = Date.parse("2025-12-13T00:00:02.000Z");
    const job = await cron.add({
      name: "one-shot hello",
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });

    expect(job.state.nextRunAtMs).toBe(atMs);

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();

    const jobs = await waitForJobs(cron, (items) =>
      items.some((item) => item.id === job.id && !item.enabled),
    );
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated?.enabled).toBe(false);
    expect(enqueueSystemEvent).toHaveBeenCalledWith("hello", {
      agentId: undefined,
    });
    expect(requestHeartbeatNow).toHaveBeenCalled();

    await cron.list({ includeDisabled: true });
    cron.stop();
    await store.cleanup();
  });

  it("runs a one-shot job and deletes it after success by default", async () => {
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
    const atMs = Date.parse("2025-12-13T00:00:02.000Z");
    const job = await cron.add({
      name: "one-shot delete",
      enabled: true,
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();

    const jobs = await waitForJobs(cron, (items) => !items.some((item) => item.id === job.id));
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();
    expect(enqueueSystemEvent).toHaveBeenCalledWith("hello", {
      agentId: undefined,
    });
    expect(requestHeartbeatNow).toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("wakeMode now waits for heartbeat completion when available", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    let now = 0;
    const nowMs = () => {
      now += 10;
      return now;
    };

    let resolveHeartbeat: ((res: HeartbeatRunResult) => void) | null = null;
    const runHeartbeatOnce = vi.fn(
      async () =>
        await new Promise<HeartbeatRunResult>((resolve) => {
          resolveHeartbeat = resolve;
        }),
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const job = await cron.add({
      name: "wakeMode now waits",
      enabled: true,
      schedule: { kind: "at", at: new Date(1).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });

    const runPromise = cron.run(job.id, "force");
    for (let i = 0; i < 10; i++) {
      if (runHeartbeatOnce.mock.calls.length > 0) {
        break;
      }
      // Let the locked() chain progress.
      await Promise.resolve();
    }

    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledWith("hello", {
      agentId: undefined,
    });
    expect(job.state.runningAtMs).toBeTypeOf("number");

    resolveHeartbeat?.({ status: "ran", durationMs: 123 });
    await runPromise;

    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastDurationMs).toBeGreaterThan(0);

    cron.stop();
    await store.cleanup();
  });

  it("passes agentId to runHeartbeatOnce for main-session wakeMode now jobs", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const job = await cron.add({
      name: "wakeMode now with agent",
      agentId: "ops",
      enabled: true,
      schedule: { kind: "at", at: new Date(1).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });

    await cron.run(job.id, "force");

    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(runHeartbeatOnce).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: `cron:${job.id}`,
        agentId: "ops",
      }),
    );
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledWith("hello", { agentId: "ops" });

    cron.stop();
    await store.cleanup();
  });

  it("wakeMode now falls back to queued heartbeat when main lane stays busy", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runHeartbeatOnce = vi.fn(async () => ({
      status: "skipped" as const,
      reason: "requests-in-flight",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();
    const job = await cron.add({
      name: "wakeMode now fallback",
      enabled: true,
      schedule: { kind: "at", at: new Date(1).toISOString() },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "hello" },
    });

    const runPromise = cron.run(job.id, "force");
    await vi.advanceTimersByTimeAsync(125_000);
    await runPromise;

    expect(runHeartbeatOnce).toHaveBeenCalled();
    expect(requestHeartbeatNow).toHaveBeenCalled();
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastError).toBeUndefined();

    await cron.list({ includeDisabled: true });
    cron.stop();
    await store.cleanup();
  });

  it("runs an isolated job and posts summary to main", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cron.add({
      enabled: true,
      name: "weekly",
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery: { mode: "announce" },
    });

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();

    await waitForJobs(cron, (items) => items.some((item) => item.state.lastStatus === "ok"));
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).toHaveBeenCalledWith("Cron: done", {
      agentId: undefined,
    });
    expect(requestHeartbeatNow).toHaveBeenCalled();
    cron.stop();
    await store.cleanup();
  });

  it("does not post isolated summary to main when run already delivered output", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      delivered: true,
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cron.add({
      enabled: true,
      name: "weekly delivered",
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery: { mode: "announce" },
    });

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();

    await waitForJobs(cron, (items) => items.some((item) => item.state.lastStatus === "ok"));
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    cron.stop();
    await store.cleanup();
  });

  it("migrates legacy payload.provider to payload.channel on load", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const rawJob = {
      id: "legacy-1",
      name: "legacy",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: true,
        provider: " TeLeGrAm ",
        to: "7200373102",
      },
      state: {},
    };

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: [rawJob] }, null, 2),
      "utf-8",
    );

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
    const job = jobs.find((j) => j.id === rawJob.id);
    // Legacy delivery fields are migrated to the top-level delivery object
    const delivery = job?.delivery as unknown as Record<string, unknown>;
    expect(delivery?.channel).toBe("telegram");
    const payload = job?.payload as unknown as Record<string, unknown>;
    expect("provider" in payload).toBe(false);
    expect("channel" in payload).toBe(false);

    cron.stop();
    await store.cleanup();
  });

  it("canonicalizes payload.channel casing on load", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    const rawJob = {
      id: "legacy-2",
      name: "legacy",
      enabled: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: "hi",
        deliver: true,
        channel: "Telegram",
        to: "7200373102",
      },
      state: {},
    };

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({ version: 1, jobs: [rawJob] }, null, 2),
      "utf-8",
    );

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
    const job = jobs.find((j) => j.id === rawJob.id);
    // Legacy delivery fields are migrated to the top-level delivery object
    const delivery = job?.delivery as unknown as Record<string, unknown>;
    expect(delivery?.channel).toBe("telegram");

    cron.stop();
    await store.cleanup();
  });

  it("posts last output to main even when isolated job errors", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
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
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();
    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await cron.add({
      name: "isolated error test",
      enabled: true,
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery: { mode: "announce" },
    });

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await waitForJobs(cron, (items) => items.some((item) => item.state.lastStatus === "error"));

    expect(enqueueSystemEvent).toHaveBeenCalledWith("Cron (error): last output", {
      agentId: undefined,
    });
    expect(requestHeartbeatNow).toHaveBeenCalled();
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
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    await expect(
      cron.add({
        name: "bad combo (main/agentTurn)",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "nope" },
      }),
    ).rejects.toThrow(/main cron jobs require/);

    await expect(
      cron.add({
        name: "bad combo (isolated/systemEvent)",
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
    const requestHeartbeatNow = vi.fn();

    const atMs = Date.parse("2025-12-13T00:00:01.000Z");
    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
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
            schedule: { kind: "at", at: new Date(atMs).toISOString() },
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
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    await cron.start();

    vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
    await vi.runOnlyPendingTimersAsync();

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();

    const jobs = await waitForJobs(cron, (items) => items[0]?.state.lastStatus === "skipped");
    expect(jobs[0]?.state.lastStatus).toBe("skipped");
    expect(jobs[0]?.state.lastError).toMatch(/main job requires/i);

    cron.stop();
    await store.cleanup();
  });
});
