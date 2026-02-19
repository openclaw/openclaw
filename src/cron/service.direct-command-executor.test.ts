import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

describe("cron directCommand execution path", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs directCommand payloads through runDirectCommandJob only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-direct-command-"));
    const storePath = path.join(fixtureRoot, "cron", "jobs.json");

    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const runDirectCommandJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));

    const cron = new CronService({
      storePath,
      cronEnabled: true,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob,
      runDirectCommandJob,
    });

    await cron.start();
    const job = await cron.add({
      name: "run-direct",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "directCommand", command: "echo", args: ["hello"] },
    });

    await cron.run(job.id, "force");

    expect(runDirectCommandJob).toHaveBeenCalledTimes(1);
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();

    cron.stop();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });
});
