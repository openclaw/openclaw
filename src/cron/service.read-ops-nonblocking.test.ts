import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      // On macOS, teardown can race with trailing async fs writes and leave
      // transient ENOTEMPTY/EBUSY errors; let fs.rm handle retries natively.
      try {
        await fs.rm(dir, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 10,
        });
      } catch {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  };
}

describe("CronService read ops while job is running", () => {
  it("keeps list and status responsive during a long isolated run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-13T00:00:00.000Z"));
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    let resolveFinished: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });

    let resolveRun:
      | ((value: { status: "ok" | "error" | "skipped"; summary?: string; error?: string }) => void)
      | undefined;

    let resolveRunStarted: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      resolveRunStarted = resolve;
    });

    const runIsolatedAgentJob = vi.fn(async () => {
      resolveRunStarted?.();
      return await new Promise<{
        status: "ok" | "error" | "skipped";
        summary?: string;
        error?: string;
      }>((resolve) => {
        resolveRun = resolve;
      });
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
      onEvent: (evt) => {
        if (evt.action === "finished" && evt.status === "ok") {
          resolveFinished?.();
        }
      },
    });

    try {
      await cron.start();

      // Schedule the job a second in the future; then jump time to trigger the tick.
      await cron.add({
        name: "slow isolated",
        enabled: true,
        deleteAfterRun: false,
        schedule: {
          kind: "at",
          at: new Date("2025-12-13T00:00:01.000Z").toISOString(),
        },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "long task" },
        delivery: { mode: "none" },
      });

      vi.setSystemTime(new Date("2025-12-13T00:00:01.000Z"));
      await vi.runOnlyPendingTimersAsync();

      await runStarted;
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

      await expect(cron.list({ includeDisabled: true })).resolves.toBeTypeOf("object");
      await expect(cron.status()).resolves.toBeTypeOf("object");

      const running = await cron.list({ includeDisabled: true });
      expect(running[0]?.state.runningAtMs).toBeTypeOf("number");

      resolveRun?.({ status: "ok", summary: "done" });

      // Wait until the scheduler writes the result back to the store.
      await finished;
      // Ensure any trailing store writes have finished before cleanup.
      await cron.status();

      const completed = await cron.list({ includeDisabled: true });
      expect(completed[0]?.state.lastStatus).toBe("ok");

      // Ensure the scheduler loop has fully settled before deleting the store directory.
      const internal = cron as unknown as { state?: { running?: boolean } };
      for (let i = 0; i < 100; i += 1) {
        if (!internal.state?.running) {
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
      }
      expect(internal.state?.running).toBe(false);
    } finally {
      cron.stop();
      vi.clearAllTimers();
      vi.useRealTimers();
      await store.cleanup();
    }
  });

  it("keeps list and status responsive during startup catch-up runs", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const nowMs = Date.parse("2025-12-13T00:00:00.000Z");

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "startup-catchup",
            name: "startup catch-up",
            enabled: true,
            createdAtMs: nowMs - 86_400_000,
            updatedAtMs: nowMs - 86_400_000,
            schedule: { kind: "at", at: new Date(nowMs - 60_000).toISOString() },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "agentTurn", message: "startup replay" },
            delivery: { mode: "none" },
            state: { nextRunAtMs: nowMs - 60_000 },
          },
        ],
      }),
      "utf-8",
    );

    let resolveRun:
      | ((value: { status: "ok" | "error" | "skipped"; summary?: string; error?: string }) => void)
      | undefined;
    let resolveRunStarted: (() => void) | undefined;
    const runStarted = new Promise<void>((resolve) => {
      resolveRunStarted = resolve;
    });

    const runIsolatedAgentJob = vi.fn(async () => {
      resolveRunStarted?.();
      return await new Promise<{
        status: "ok" | "error" | "skipped";
        summary?: string;
        error?: string;
      }>((resolve) => {
        resolveRun = resolve;
      });
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => nowMs,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    try {
      const startPromise = cron.start();
      await runStarted;

      await expect(
        withTimeout(cron.list({ includeDisabled: true }), 300, "cron.list during startup"),
      ).resolves.toBeTypeOf("object");
      await expect(withTimeout(cron.status(), 300, "cron.status during startup")).resolves.toEqual(
        expect.objectContaining({ enabled: true, storePath: store.storePath }),
      );

      resolveRun?.({ status: "ok", summary: "done" });
      await startPromise;

      const jobs = await cron.list({ includeDisabled: true });
      expect(jobs[0]?.state.lastStatus).toBe("ok");
      expect(jobs[0]?.state.runningAtMs).toBeUndefined();
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
