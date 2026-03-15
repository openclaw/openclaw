import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { updateSessionStore } from "../config/sessions/store.js";
import { resolveCronRunLogPath } from "./run-log.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-remove-cleanup-" });
installCronTestHooks({ logger });

function createCronService(storePath: string, sessionStorePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: logger,
    sessionStorePath,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

describe("CronService.remove cleanup (#46369)", () => {
  it("removes session entries matching the deleted job from sessions.json", async () => {
    const { storePath } = await makeStorePath();
    const sessionsDir = path.join(path.dirname(storePath), "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    const sessionStorePath = path.join(sessionsDir, "sessions.json");

    const cron = createCronService(storePath, sessionStorePath);
    await cron.start();

    try {
      const job = await cron.add({
        name: "cleanup-test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ping" },
      });

      // Seed sessions.json with canonical + run keys for this job, and another job.
      await updateSessionStore(sessionStorePath, (store) => {
        // Canonical key (no :run: suffix).
        store[`agent:main:cron:${job.id}`] = {
          sessionId: "sess-canonical",
          updatedAt: Date.now(),
        } as never;
        // Run-specific keys.
        store[`agent:main:cron:${job.id}:run:run-1`] = {
          sessionId: "sess-1",
          updatedAt: Date.now(),
        } as never;
        store[`agent:main:cron:${job.id}:run:run-2`] = {
          sessionId: "sess-2",
          updatedAt: Date.now(),
        } as never;
        // Another job's sessions — should survive.
        store["agent:main:cron:other-job"] = {
          sessionId: "sess-other-canonical",
          updatedAt: Date.now(),
        } as never;
        store["agent:main:cron:other-job:run:run-3"] = {
          sessionId: "sess-3",
          updatedAt: Date.now(),
        } as never;
      });

      // Remove the job.
      const result = await cron.remove(job.id);
      expect(result.removed).toBe(true);

      // Wait for async cleanup to complete.
      await vi.waitFor(async () => {
        const storeContent = await fs.readFile(sessionStorePath, "utf-8");
        const store = JSON.parse(storeContent);
        // All sessions for the deleted job should be gone (canonical + run keys).
        expect(store[`agent:main:cron:${job.id}`]).toBeUndefined();
        expect(store[`agent:main:cron:${job.id}:run:run-1`]).toBeUndefined();
        expect(store[`agent:main:cron:${job.id}:run:run-2`]).toBeUndefined();
        // Other job's sessions should remain.
        expect(store["agent:main:cron:other-job"]).toBeDefined();
        expect(store["agent:main:cron:other-job:run:run-3"]).toBeDefined();
      });
    } finally {
      cron.stop();
    }
  });

  it("deletes the run log file for the removed job", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath, "");
    await cron.start();

    try {
      const job = await cron.add({
        name: "runlog-test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "ping" },
      });

      // Create a fake run log file.
      const logPath = resolveCronRunLogPath({ storePath, jobId: job.id });
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(logPath, '{"status":"ok"}\n');

      // Remove the job.
      const result = await cron.remove(job.id);
      expect(result.removed).toBe(true);

      // Wait for async cleanup.
      await vi.waitFor(async () => {
        await expect(fs.access(logPath)).rejects.toThrow();
      });
    } finally {
      cron.stop();
    }
  });
});
