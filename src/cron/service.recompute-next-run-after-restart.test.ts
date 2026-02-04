import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { start } from "./service/ops.js";
import { createCronServiceState } from "./service/state.js";

// Regression test for issue #9022:
// After restart, cron should recompute nextRunAtMs based on *now*, not advance 24h from lastRunAtMs.

describe("cron: recompute nextRunAtMs on start", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (!tmpDir) return;
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("does not skip intermediate cron slots after restart", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-test-"));
    const storePath = path.join(tmpDir, "cron-store.json");

    // Day N: job ran at 20:00 Europe/Zurich = 19:00Z (example)
    // Day N+1 restart at 09:00Z should schedule 12:00 Europe/Zurich = 11:00Z.
    const lastRunAtMs = Date.parse("2026-02-03T19:00:00.104Z");
    const restartNowMs = Date.parse("2026-02-04T09:00:00.000Z");

    const state = createCronServiceState({
      cronEnabled: true,
      storePath,
      nowMs: () => restartNowMs,
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      enqueueSystemEvent: () => undefined,
      requestHeartbeatNow: () => undefined,
      runIsolatedAgentJob: async () => ({ status: "skipped" }),
    });

    // Seed store without going through persistence.
    state.store = {
      version: 1,
      jobs: [
        {
          id: "job",
          agentId: "main",
          name: "cron slot test",
          enabled: true,
          createdAtMs: lastRunAtMs,
          updatedAtMs: lastRunAtMs,
          schedule: { kind: "cron", expr: "0 12,16,20 * * 1-5", tz: "Europe/Zurich" },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "hi", deliver: false },
          state: {
            lastRunAtMs,
            lastStatus: "ok",
            // This is the buggy persisted value shown in the issue report.
            nextRunAtMs: Date.parse("2026-02-04T19:00:00.000Z"),
          },
        },
      ],
    };

    await start(state);

    const next = state.store.jobs[0].state.nextRunAtMs;
    expect(next).toBe(Date.parse("2026-02-04T11:00:00.000Z"));
  });
});
