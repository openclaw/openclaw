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

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("CronService read ops while job is running", () => {
  it("keeps list and status responsive during a long isolated run", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    let resolveRun:
      | ((value: { status: "ok" | "error" | "skipped"; summary?: string; error?: string }) => void)
      | undefined;

    const runIsolatedAgentJob = vi.fn(
      async () =>
        await new Promise<{
          status: "ok" | "error" | "skipped";
          summary?: string;
          error?: string;
        }>((resolve) => {
          resolveRun = resolve;
        }),
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    const timeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
      let t: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new Error("timeout")), ms);
      });
      return await Promise.race([promise.finally(() => clearTimeout(t!)), timeoutPromise]);
    };

    try {
      await cron.start();

      // Schedule the job in the past so the cron timer fires immediately.
      await cron.add({
        name: "slow isolated",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() - 1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "long task" },
        delivery: { mode: "none" },
      });

      // Let the scheduler tick and start the job.
      await timeout(
        (async () => {
          for (;;) {
            if (runIsolatedAgentJob.mock.calls.length > 0) {
              return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        })(),
        200,
      );

      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

      await expect(timeout(cron.list({ includeDisabled: true }), 100)).resolves.toBeTypeOf(
        "object",
      );
      await expect(timeout(cron.status(), 100)).resolves.toBeTypeOf("object");

      const running = await cron.list({ includeDisabled: true });
      expect(running[0]?.state.runningAtMs).toBeTypeOf("number");

      resolveRun?.({ status: "ok", summary: "done" });

      await timeout(
        (async () => {
          for (;;) {
            const finished = await cron.list({ includeDisabled: true });
            if (finished[0]?.state.lastStatus === "ok") {
              return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        })(),
        500,
      );
    } finally {
      cron.stop();
      await store.cleanup();
    }
  });
});
