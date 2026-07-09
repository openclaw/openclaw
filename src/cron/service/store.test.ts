// Cron service store tests cover persisted service state loading and writes.
import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { setupCronServiceSuite } from "../service.test-harness.js";
import {
  loadCronCatchupDeferralFile,
  loadCronStore,
  resolveCronCatchupDeferralPath,
  saveCronCatchupDeferralFile,
  saveCronStore,
} from "../store.js";
import type { CronJob } from "../types.js";
import { findJobOrThrow, recomputeNextRunsForMaintenance } from "./jobs.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded, persist } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-store-seam",
});

const STORE_TEST_NOW = Date.parse("2026-03-23T12:00:00.000Z");

async function writeSingleJobStore(storePath: string, job: Record<string, unknown>) {
  await writeJobStore(storePath, [job]);
}

async function writeJobStore(storePath: string, jobs: unknown[]) {
  await saveCronStore(storePath, {
    version: 1,
    jobs: jobs as CronJob[],
  });
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function createStoreTestState(storePath: string) {
  return createCronServiceState({
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => STORE_TEST_NOW,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function createReloadCronJob(params?: Partial<CronJob>): CronJob {
  return {
    id: "reload-cron-expr-job",
    name: "reload cron expr job",
    enabled: true,
    createdAtMs: STORE_TEST_NOW - 60_000,
    updatedAtMs: STORE_TEST_NOW - 60_000,
    schedule: { kind: "cron", expr: "0 6 * * *", tz: "UTC" },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "tick" },
    state: {},
    ...params,
  };
}
describe("cron service store seam coverage", () => {
  it("loads stored jobs, recomputes next runs, and does not rewrite the store on load", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      id: "modern-job",
      name: "modern job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "ping" },
      delivery: { mode: "announce", channel: "telegram", to: "123" },
      state: {},
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = state.store?.jobs[0];
    if (!job) {
      throw new Error("expected loaded cron job");
    }
    expect(job.sessionTarget).toBe("isolated");
    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.message).toBe("ping");
    }
    expect(job.delivery?.mode).toBe("announce");
    expect(job.delivery?.channel).toBe("telegram");
    expect(job.delivery?.to).toBe("123");
    expect(job?.state.nextRunAtMs).toBe(STORE_TEST_NOW + 60_000);

    const persistedJob = (await loadCronStore(storePath)).jobs[0];
    const persistedPayload = persistedJob?.payload as
      | { kind?: string; message?: string }
      | undefined;
    expect(persistedPayload?.kind).toBe("agentTurn");
    expect(persistedPayload?.message).toBe("ping");
    const persistedDelivery = persistedJob?.delivery as
      | { mode?: string; channel?: string; to?: string }
      | undefined;
    expect(persistedDelivery?.mode).toBe("announce");
    expect(persistedDelivery?.channel).toBe("telegram");
    expect(persistedDelivery?.to).toBe("123");
    await expectPathMissing(storePath);

    await persist(state);
  });

  it("loads normalized jobId-only jobs from SQLite so scheduler lookups resolve by stable id", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      jobId: "repro-stable-id",
      name: "handed",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = findJobOrThrow(state, "repro-stable-id");
    expect(job.id).toBe("repro-stable-id");
    expect((job as { jobId?: unknown }).jobId).toBeUndefined();
    await expectPathMissing(`${storePath}.migrated`);
  });

  it("preserves disabled jobs when persisted booleans roundtrip through string values", async () => {
    const { storePath } = await makeStorePath();

    await writeSingleJobStore(storePath, {
      id: "disabled-string-job",
      name: "disabled string job",
      enabled: "false",
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = findJobOrThrow(state, "disabled-string-job");
    expect(job.enabled).toBe(false);
    await expectPathMissing(`${storePath}.migrated`);
  });

  it("loads persisted jobs with opaque custom session ids containing separators", async () => {
    const { storePath } = await makeStorePath();
    const sessionTarget = "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";

    await writeSingleJobStore(storePath, {
      id: "opaque-session-target-job",
      name: "opaque session target job",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget,
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "ping" },
      state: {},
    });

    const state = createStoreTestState(storePath);

    await ensureLoaded(state, { skipRecompute: true });

    const job = findJobOrThrow(state, "opaque-session-target-job");
    expect(job.sessionTarget).toBe(sessionTarget);
    const warnCalls = logger.warn.mock.calls as unknown as Array<
      [{ storePath?: string; jobId?: string }, string]
    >;
    expect(
      warnCalls.some(
        ([metadata, message]) =>
          metadata.jobId === "opaque-session-target-job" &&
          message.includes("invalid persisted sessionTarget"),
      ),
    ).toBe(false);
  });

  it("clears stale nextRunAtMs after force reload when cron schedule expression changes", async () => {
    const { storePath } = await makeStorePath();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(staleNextRunAtMs);

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          updatedAtMs: STORE_TEST_NOW - 30_000,
          schedule: { kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" },
          state: {},
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    const reloadedJob = findJobOrThrow(state, "reload-cron-expr-job");
    expect(reloadedJob.schedule).toEqual({ kind: "cron", expr: "30 6 * * 0,6", tz: "UTC" });
    expect(reloadedJob.state.nextRunAtMs).toBeUndefined();
  });

  it("preserves nextRunAtMs after force reload when cron schedule key order changes only", async () => {
    const { storePath } = await makeStorePath();
    const dueNextRunAtMs = STORE_TEST_NOW - 1_000;

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          state: { nextRunAtMs: dueNextRunAtMs },
        }),
      ],
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });

    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          updatedAtMs: STORE_TEST_NOW - 30_000,
          schedule: { expr: "0 6 * * *", kind: "cron", tz: "UTC" },
          state: { nextRunAtMs: dueNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(dueNextRunAtMs);
  });

  it("preserves nextRunAtMs after force reload when scheduling inputs are unchanged", async () => {
    const { storePath } = await makeStorePath();
    const originalNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({ state: { nextRunAtMs: originalNextRunAtMs } }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          updatedAtMs: STORE_TEST_NOW,
          state: { nextRunAtMs: originalNextRunAtMs + 60_000 },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBe(
      originalNextRunAtMs + 60_000,
    );
  });

  it("clears stale nextRunAtMs after force reload when enabled state changes", async () => {
    const { storePath } = await makeStorePath();
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        enabled: true,
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          enabled: false,
          updatedAtMs: STORE_TEST_NOW,
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, "reload-cron-expr-job").state.nextRunAtMs).toBeUndefined();
  });

  it("clears stale nextRunAtMs after force reload when every schedule anchor changes", async () => {
    const { storePath } = await makeStorePath();
    const jobId = "reload-every-anchor-job";
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        id: jobId,
        schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW - 60_000 },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          id: jobId,
          updatedAtMs: STORE_TEST_NOW,
          schedule: { kind: "every", everyMs: 60_000, anchorMs: STORE_TEST_NOW },
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, jobId).state.nextRunAtMs).toBeUndefined();
  });

  it("clears stale nextRunAtMs after force reload when at schedule target changes", async () => {
    const { storePath } = await makeStorePath();
    const jobId = "reload-at-target-job";
    const staleNextRunAtMs = STORE_TEST_NOW + 3_600_000;

    await writeSingleJobStore(storePath, {
      ...createReloadCronJob({
        id: jobId,
        schedule: { kind: "at", at: "2026-03-23T13:00:00.000Z" },
        state: { nextRunAtMs: staleNextRunAtMs },
      }),
    });

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          id: jobId,
          updatedAtMs: STORE_TEST_NOW,
          schedule: { kind: "at", at: "2026-03-23T14:00:00.000Z" },
          state: { nextRunAtMs: staleNextRunAtMs },
        }),
      ],
    });

    await ensureLoaded(state, { forceReload: true, skipRecompute: true });

    expect(findJobOrThrow(state, jobId).state.nextRunAtMs).toBeUndefined();
  });

  it("preserves a persisted startup catch-up deferral across a simulated process restart (#102236)", async () => {
    const { storePath } = await makeStorePath();
    // A non-natural near-future slot, like the staggered startup catch-up slot
    // `baseNow + offset` the scheduler parks overflow jobs in.
    const deferredSlot = STORE_TEST_NOW + 5_000;
    const jobId = "restart-deferred-daily";

    // A previous process parked this overflow daily job at the staggered
    // catch-up slot and persisted the deferral marker to the internal sidecar.
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        createReloadCronJob({
          id: jobId,
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
          state: { nextRunAtMs: deferredSlot },
        }),
      ],
    });
    saveCronCatchupDeferralFile({ storePath, jobIds: new Set([jobId]) });

    // Fresh process: the in-memory marker set starts empty, then loads from disk.
    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });

    expect(state.pendingCatchupDeferralJobIds.has(jobId)).toBe(true);

    // Start-time maintenance would otherwise advance a non-natural future slot
    // to the next natural run (tomorrow 09:00); the persisted marker must
    // suppress that repair so the catch-up slot survives the restart.
    recomputeNextRunsForMaintenance(state, { recomputeExpired: true });

    expect(findJobOrThrow(state, jobId).state.nextRunAtMs).toBe(deferredSlot);
  });

  it("persists the catch-up deferral marker set to an internal sidecar and removes it once drained (#102236)", async () => {
    const { storePath } = await makeStorePath();
    const deferralPath = resolveCronCatchupDeferralPath(storePath);
    await expectPathMissing(deferralPath);

    const state = createStoreTestState(storePath);
    await ensureLoaded(state, { skipRecompute: true });

    // The marker set is internal scheduler bookkeeping and must round-trip
    // through its own sidecar, never through the public CronJobState.
    state.pendingCatchupDeferralJobIds.add("drained-job");
    await persist(state);
    expect([...loadCronCatchupDeferralFile(deferralPath)]).toEqual(["drained-job"]);

    // Once the marker set drains, the sidecar is removed so a later restart
    // never observes a stale id.
    state.pendingCatchupDeferralJobIds.delete("drained-job");
    await persist(state);
    await expectPathMissing(deferralPath);
  });
});
