import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { writeCronStoreSnapshot } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { armTimer } from "./service/timer.js";
import { loadCronStore } from "./store.js";
import type { CronJob } from "./types.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-stop-graceful-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
      } catch {
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function makeFutureJob(id: string): CronJob {
  const now = Date.now();
  return {
    id,
    name: `job-${id}`,
    enabled: true,
    createdAtMs: now - 86400_000,
    updatedAtMs: now - 86400_000,
    schedule: { kind: "every", everyMs: 3600_000, anchorMs: now - 86400_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
    state: {},
  };
}

function makeCronService(storePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

describe("CronService.stopGraceful", () => {
  it("flushes in-memory state to disk before returning", async () => {
    const store = await makeStorePath();
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [makeFutureJob("flush-job")],
    });

    const cron = makeCronService(store.storePath);
    await cron.start();

    // Update delivery config via API (persists immediately, but also
    // exercises the stopGraceful flush path)
    await cron.update("flush-job", {
      delivery: { mode: "announce", channel: "telegram", to: "-1001234567890" },
    });

    await cron.stopGraceful();

    // Re-read from disk — delivery config must be preserved
    const diskStore = await loadCronStore(store.storePath);
    const diskJob = diskStore.jobs.find((j: { id: string }) => j.id === "flush-job");
    expect(diskJob).toBeDefined();
    expect(diskJob?.delivery?.channel).toBe("telegram");
    expect(diskJob?.delivery?.to).toBe("-1001234567890");
    expect(diskJob?.delivery?.mode).toBe("announce");

    await store.cleanup();
  });

  it("new service reads correct state after old service stopGraceful (#30098)", async () => {
    const store = await makeStorePath();
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [makeFutureJob("replace-job")],
    });

    // Old service: start, update delivery config
    const oldCron = makeCronService(store.storePath);
    await oldCron.start();
    await oldCron.update("replace-job", {
      delivery: { mode: "announce", channel: "slack", to: "#alerts" },
    });

    // Gracefully stop (simulates hot reload cron restart)
    await oldCron.stopGraceful();

    // New replacement service loads from disk
    const newCron = makeCronService(store.storePath);
    await newCron.start();

    const jobs = await newCron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === "replace-job");
    expect(updated?.delivery?.mode).toBe("announce");
    expect(updated?.delivery?.channel).toBe("slack");
    expect(updated?.delivery?.to).toBe("#alerts");

    newCron.stop();
    await store.cleanup();
  });

  it("stopGraceful is safe to call when store is not loaded", async () => {
    const store = await makeStorePath();
    await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [] });

    // Create service but do NOT call start() — store is null
    const cron = makeCronService(store.storePath);
    await expect(cron.stopGraceful()).resolves.toBeUndefined();

    await store.cleanup();
  });

  it("stopping flag prevents armTimer from re-arming after stopGraceful", async () => {
    const store = await makeStorePath();
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [makeFutureJob("rearm-guard-job")],
    });

    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });

    const futureMs = Date.now() + 60_000;
    const job = makeFutureJob("rearm-guard-job");
    job.state.nextRunAtMs = futureMs;
    state.store = { version: 1, jobs: [job] };

    // Before stopping, armTimer should arm the timer
    armTimer(state);
    expect(state.timer).not.toBeNull();

    // Set the stopping flag (as stopGraceful would)
    state.stopping = true;
    clearTimeout(state.timer!);
    state.timer = null;

    // armTimer should now refuse to re-arm
    armTimer(state);
    expect(state.timer).toBeNull();

    await store.cleanup();
  });
});
