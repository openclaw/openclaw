import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { onTimer } from "./service/timer.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-stale-marker-" });
installCronTestHooks({ logger: noopLogger, baseTimeIso: "2026-02-10T12:00:00.000Z" });

async function writeStoreJobs(storePath: string, jobs: unknown[]) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2), "utf-8");
}

describe("stale runningAtMs marker auto-clearing (#18120)", () => {
  it("clears stale runningAtMs and persists even when job is not yet due", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T12:00:00.000Z");

    // Job with stale runningAtMs (started 30 min ago, well past 2x the 10-min default timeout)
    // but nextRunAtMs is in the future (not due yet).
    await writeStoreJobs(store.storePath, [
      {
        id: "stale-job",
        name: "stale job",
        enabled: true,
        deleteAfterRun: false,
        createdAtMs: now - 3_600_000,
        updatedAtMs: now - 3_600_000,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "test" },
        delivery: { mode: "none" },
        state: {
          runningAtMs: now - 30 * 60_000, // 30 min ago (> 2x 10-min timeout)
          nextRunAtMs: now + 60_000, // 1 min from now (not due)
        },
      },
    ]);

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });

    await onTimer(state);

    // The warn log should have fired for stale marker clearing.
    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "stale-job" }),
      "cron: auto-clearing stale runningAtMs marker",
    );

    // Read the persisted store to verify runningAtMs was cleared on disk.
    const raw = await fs.readFile(store.storePath, "utf-8");
    const persisted = JSON.parse(raw);
    const job = persisted.jobs.find((j: { id: string }) => j.id === "stale-job");
    expect(job.state.runningAtMs).toBeUndefined();
  });

  it("does not clear runningAtMs when within timeout threshold", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T12:00:00.000Z");

    // Job started 5 min ago (within 2x the 10-min timeout = 20 min threshold).
    await writeStoreJobs(store.storePath, [
      {
        id: "active-job",
        name: "active job",
        enabled: true,
        deleteAfterRun: false,
        createdAtMs: now - 3_600_000,
        updatedAtMs: now - 3_600_000,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "test" },
        delivery: { mode: "none" },
        state: {
          runningAtMs: now - 5 * 60_000, // 5 min ago (< 2x 10-min timeout)
          nextRunAtMs: now + 60_000, // not due
        },
      },
    ]);

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });

    await onTimer(state);

    // No stale-marker warning should fire.
    expect(noopLogger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "active-job" }),
      "cron: auto-clearing stale runningAtMs marker",
    );

    // Persisted store should still have runningAtMs set.
    const raw = await fs.readFile(store.storePath, "utf-8");
    const persisted = JSON.parse(raw);
    const job = persisted.jobs.find((j: { id: string }) => j.id === "active-job");
    expect(job.state.runningAtMs).toBe(now - 5 * 60_000);
  });

  it("uses job-specific timeoutSeconds for stale threshold calculation", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-10T12:00:00.000Z");
    const customTimeoutSec = 30; // 30 seconds -> stale after 60 seconds

    // Job started 90 seconds ago with a 30-second custom timeout (stale after 60s).
    await writeStoreJobs(store.storePath, [
      {
        id: "custom-timeout-job",
        name: "custom timeout job",
        enabled: true,
        deleteAfterRun: false,
        createdAtMs: now - 3_600_000,
        updatedAtMs: now - 3_600_000,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "test", timeoutSeconds: customTimeoutSec },
        delivery: { mode: "none" },
        state: {
          runningAtMs: now - 90_000, // 90s ago (> 2x 30s = 60s threshold)
          nextRunAtMs: now + 60_000, // not due
        },
      },
    ]);

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    });

    await onTimer(state);

    expect(noopLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "custom-timeout-job", staleThresholdMs: 60_000 }),
      "cron: auto-clearing stale runningAtMs marker",
    );
  });
});
