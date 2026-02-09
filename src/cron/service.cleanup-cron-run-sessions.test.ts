import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { isCronRunSessionKey } from "./service/sweeper.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-cleanup-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("cron run session cleanup", () => {
  beforeEach(() => {
    noopLogger.debug.mockClear();
    noopLogger.info.mockClear();
    noopLogger.warn.mockClear();
    noopLogger.error.mockClear();
  });

  it("calls cleanupCronRunSession after isolated job with default cleanup", async () => {
    const store = await makeStorePath();
    const cleanupCronRunSession = vi.fn(async () => {});
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionId: "run-uuid-1",
      sessionKey: "agent:main:cron:job-1:run:run-uuid-1",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      cleanupCronRunSession,
    });

    await cron.start();
    const job = await cron.add({
      name: "cleanup-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
    });

    await cron.run(job.id, "force");

    // Give the fire-and-forget cleanup promise a tick to resolve.
    await new Promise((r) => setTimeout(r, 10));

    expect(cleanupCronRunSession).toHaveBeenCalledTimes(1);
    expect(cleanupCronRunSession).toHaveBeenCalledWith(
      "agent:main:cron:job-1:run:run-uuid-1",
      expect.objectContaining({ name: "cleanup-test" }),
    );

    cron.stop();
    await store.cleanup();
  });

  it("does not call cleanupCronRunSession when cleanup is 'keep'", async () => {
    const store = await makeStorePath();
    const cleanupCronRunSession = vi.fn(async () => {});
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionId: "run-uuid-2",
      sessionKey: "agent:main:cron:job-2:run:run-uuid-2",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      cleanupCronRunSession,
    });

    await cron.start();
    const job = await cron.add({
      name: "keep-test",
      enabled: true,
      cleanup: "keep",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
    });

    await cron.run(job.id, "force");
    await new Promise((r) => setTimeout(r, 10));

    expect(cleanupCronRunSession).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("does not call cleanup when sessionKey is not a :run: key", async () => {
    const store = await makeStorePath();
    const cleanupCronRunSession = vi.fn(async () => {});
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionId: "run-uuid-3",
      sessionKey: "agent:main:cron:job-3",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      cleanupCronRunSession,
    });

    await cron.start();
    const job = await cron.add({
      name: "no-run-key-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
    });

    await cron.run(job.id, "force");
    await new Promise((r) => setTimeout(r, 10));

    expect(cleanupCronRunSession).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });

  it("does not crash when cleanupCronRunSession throws", async () => {
    const store = await makeStorePath();
    const cleanupCronRunSession = vi.fn(async () => {
      throw new Error("session store unavailable");
    });
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      sessionId: "run-uuid-4",
      sessionKey: "agent:main:cron:job-4:run:run-uuid-4",
    }));

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob,
      cleanupCronRunSession,
    });

    await cron.start();
    const job = await cron.add({
      name: "error-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
    });

    await cron.run(job.id, "force");
    await new Promise((r) => setTimeout(r, 10));

    // Should have been called but failure is swallowed.
    expect(cleanupCronRunSession).toHaveBeenCalledTimes(1);
    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated?.state.lastStatus).toBe("ok");

    cron.stop();
    await store.cleanup();
  });

  it("main jobs do not trigger cleanup", async () => {
    const store = await makeStorePath();
    const cleanupCronRunSession = vi.fn(async () => {});

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
      cleanupCronRunSession,
    });

    await cron.start();
    const job = await cron.add({
      name: "main-job-test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });

    await cron.run(job.id, "force");
    await new Promise((r) => setTimeout(r, 10));

    expect(cleanupCronRunSession).not.toHaveBeenCalled();

    cron.stop();
    await store.cleanup();
  });
});

describe("isCronRunSessionKey", () => {
  it("matches :run: session keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc:run:uuid-123")).toBe(true);
    expect(isCronRunSessionKey("agent:main:cron:318494c1-7dfb:run:00058304-43af")).toBe(true);
  });

  it("rejects non-:run: keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc")).toBe(false);
    expect(isCronRunSessionKey("agent:main:main")).toBe(false);
    expect(isCronRunSessionKey("agent:main:telegram:group:123")).toBe(false);
  });
});
