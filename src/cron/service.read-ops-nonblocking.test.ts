import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
        await new Promise<{ status: "ok" | "error" | "skipped"; summary?: string; error?: string }>(
          (resolve) => {
            resolveRun = resolve;
          },
        ),
    );

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
    });

    await cron.start();

    const runAt = Date.now() + 30;
    await cron.add({
      name: "slow isolated",
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "at", at: new Date(runAt).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "long task" },
      delivery: { mode: "none" },
    });

    for (let i = 0; i < 25 && runIsolatedAgentJob.mock.calls.length === 0; i++) {
      await delay(20);
    }

    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);

    const listRace = await Promise.race([
      cron.list({ includeDisabled: true }).then(() => "ok"),
      delay(200).then(() => "timeout"),
    ]);
    expect(listRace).toBe("ok");

    const statusRace = await Promise.race([
      cron.status().then(() => "ok"),
      delay(200).then(() => "timeout"),
    ]);
    expect(statusRace).toBe("ok");

    const running = await cron.list({ includeDisabled: true });
    expect(running[0]?.state.runningAtMs).toBeTypeOf("number");

    resolveRun?.({ status: "ok", summary: "done" });

    for (let i = 0; i < 25; i++) {
      const jobs = await cron.list({ includeDisabled: true });
      if (jobs[0]?.state.lastStatus === "ok") {
        break;
      }
      await delay(20);
    }

    const finished = await cron.list({ includeDisabled: true });
    expect(finished[0]?.state.lastStatus).toBe("ok");

    cron.stop();
    await store.cleanup();
  });
});
