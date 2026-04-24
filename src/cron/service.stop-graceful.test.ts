import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  clearCommandLane,
  setCommandLaneConcurrency,
} from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { CronService } from "./service.js";
import { createDeferred, writeCronStoreSnapshot } from "./service.test-harness.js";
import { locked } from "./service/locked.js";
import { stopGraceful as stopGracefulOp } from "./service/ops.js";
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

  it("waits for an in-flight locked() operation before returning", async () => {
    const store = await makeStorePath();
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [makeFutureJob("inflight-job")],
    });

    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    state.store = { version: 1, jobs: [makeFutureJob("inflight-job")] };

    // Hold the locked() chain open with a deferred.  This simulates an
    // in-flight timer tick or API mutation that hasn't finished persisting
    // at the moment hot reload begins.
    const release = createDeferred<void>();
    let lockedOpResolved = false;
    const lockedOp = locked(state, async () => {
      await release.promise;
      lockedOpResolved = true;
    });

    // Yield one microtask so the locked op is actually running (not just queued).
    await Promise.resolve();

    // Start stopGraceful while the lock is held.
    let stopGracefulResolved = false;
    const stopPromise = stopGracefulOp(state).then(() => {
      stopGracefulResolved = true;
    });

    // Give the event loop a few turns to prove stopGraceful is blocked.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(lockedOpResolved).toBe(false);
    expect(stopGracefulResolved).toBe(false);

    // Release the in-flight op.  stopGraceful must only resolve after.
    release.resolve();
    await lockedOp;
    expect(lockedOpResolved).toBe(true);
    await stopPromise;
    expect(stopGracefulResolved).toBe(true);

    await store.cleanup();
  });

  it("drains in-flight enqueueRun manual runs before returning", async () => {
    // Isolate from any lane state leaked by prior tests in this process.
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = await makeStorePath();
    // Seed a job with a FUTURE nextRunAtMs so startup catch-up does not
    // pick it up; we'll trigger it manually via enqueueRun("force").
    const seedJob = makeFutureJob("manual-run-job");
    seedJob.state.nextRunAtMs = Date.now() + 3600_000;
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [seedJob],
    });

    // Deferred runIsolatedAgentJob — the manual run pauses here, inside
    // executeJobCoreWithTimeout, which runs OUTSIDE the locked() queue.
    // stopGraceful must wait for this to resolve, then for the subsequent
    // finishPreparedManualRun persist, before returning.
    const agentJobRelease = createDeferred<{ status: "ok" }>();
    const runIsolatedAgentJob = vi.fn(async () => {
      return await agentJobRelease.promise;
    });

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: runIsolatedAgentJob as never,
    });
    await cron.start();

    // Dispatch a manual run on CommandLane.Cron.  It will block inside
    // executeJobCoreWithTimeout on agentJobRelease.
    const enqueueResult = await cron.enqueueRun("manual-run-job", "force");
    expect(enqueueResult.ok).toBe(true);

    // Wait until the isolated job runner has actually been invoked — this
    // confirms the manual run has passed the prepare-phase locked() block
    // and is now running outside the lock, which is the scenario the
    // original PR's drain did NOT cover.
    for (let i = 0; i < 100 && runIsolatedAgentJob.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runIsolatedAgentJob).toHaveBeenCalled();

    // stopGraceful must now block until we release the manual run.
    let stopResolved = false;
    const stopPromise = cron.stopGraceful().then(() => {
      stopResolved = true;
    });

    // Prove blocked: wait a short real-time window while the deferred is
    // unresolved, stopGraceful must not have returned.
    await new Promise((r) => setTimeout(r, 50));
    expect(stopResolved).toBe(false);

    // Release the isolated job runner — manual run completes,
    // finishPreparedManualRun persists, stopGraceful resolves.
    agentJobRelease.resolve({ status: "ok" });
    await stopPromise;
    expect(stopResolved).toBe(true);

    // On-disk state must reflect the completed manual run: nextRunAtMs
    // recomputed for the next schedule, runningAtMs cleared.
    const diskStore = await loadCronStore(store.storePath);
    const diskJob = diskStore.jobs.find((j) => j.id === "manual-run-job");
    expect(diskJob).toBeDefined();
    expect(diskJob?.state.runningAtMs).toBeUndefined();
    expect(diskJob?.state.lastRunAtMs).toBeDefined();

    await store.cleanup();
  });

  it("rejects new enqueueRun after stopGraceful begins", async () => {
    clearCommandLane(CommandLane.Cron);
    setCommandLaneConcurrency(CommandLane.Cron, 1);

    const store = await makeStorePath();
    const seedJob = makeFutureJob("reject-after-stop");
    seedJob.state.nextRunAtMs = Date.now() + 3600_000;
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [seedJob],
    });

    const cron = makeCronService(store.storePath);
    await cron.start();
    await cron.stopGraceful();

    const result = await cron.enqueueRun("reject-after-stop", "force");
    expect(result.ok).toBe(false);

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
