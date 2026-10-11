// Cron service store tests cover persisted service state loading and writes.
import fs from "node:fs/promises";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import * as cronStoreModule from "../store.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import {
  CronRunReceiptConflictError,
  finishCronRunReceiptAsync,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.js";
import { claimCronRunReceiptInDatabaseForTest } from "../store/run-receipt-store.test-support.js";
import type { CronJob } from "../types.js";
import { findJobOrThrow } from "./jobs-scheduling.js";
import { prepareCronRunReceiptOwnerMutation } from "./run-receipts.js";
import { createCronServiceState } from "./state.js";
import {
  ensureLoaded,
  snapshotStoreForRollback,
  captureCronJobMutationSource,
  persistCronJobMutation,
} from "./store.js";

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

function createStoreTestState(storePath: string, onEvent = vi.fn()) {
  return createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => STORE_TEST_NOW,
    enqueueSystemEvent: vi.fn(),
    enqueueSessionEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    onEvent,
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a loaded snapshot stale when a writer advances its revision during loading", async () => {
    const { storePath } = await makeStorePath();
    const state = createStoreTestState(storePath);
    const first = createReloadCronJob({ id: "before-write" });
    const second = createReloadCronJob({ id: "after-write" });
    const loaded = (job: CronJob) => ({
      store: { version: 1 as const, jobs: [job] },
      configJobs: [{ ...job }],
      configJobIndexes: [0],
      configJobRuntimeEntries: [{ state: job.state }],
      invalidConfigRows: [],
    });
    const read = vi
      .spyOn(cronStoreModule, "loadCronJobsStoreWithConfigJobs")
      .mockImplementationOnce(async () => {
        cronStoreModule.noteCronJobsStoreCommit(storePath);
        return loaded(first);
      })
      .mockResolvedValue(loaded(second));

    await ensureLoaded(state);
    expect(state.store?.jobs[0]?.id).toBe("before-write");
    await ensureLoaded(state);
    expect(state.store?.jobs[0]?.id).toBe("after-write");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("loads stored jobs without schedule repair or rewriting the store", async () => {
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
    expect(job.state.nextRunAtMs).toBeUndefined();

    const persistedJob = (await loadCronStore(storePath)).jobs[0];
    expect(persistedJob?.state.nextRunAtMs).toBeUndefined();
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
  });

  it("quarantines malformed SQLite rows atomically without creating JSON state", async () => {
    const { storePath } = await makeStorePath();
    const malformed = createReloadCronJob({ id: "malformed-sqlite-row" });
    const legacyValid = createReloadCronJob({ id: "legacy-valid" });
    const legacyValidTrigger = createReloadCronJob({ id: "legacy-valid-trigger" });
    const legacyInvalidTrigger = createReloadCronJob({ id: "legacy-invalid-trigger" });
    const legacyMissingPayload = createReloadCronJob({ id: "legacy-missing-payload" });
    const surviving = createReloadCronJob({
      id: "surviving-sqlite-row",
      state: { nextRunAtMs: STORE_TEST_NOW + 60_000 },
    });
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        malformed,
        legacyValid,
        legacyValidTrigger,
        legacyInvalidTrigger,
        legacyMissingPayload,
        surviving,
      ],
    });
    const db = openOpenClawStateDatabase().db;
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.schedule.kind', ?) WHERE job_id = ?",
    ).run("unsupported", malformed.id);
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.schedule', ?) WHERE job_id IN (?, ?, ?, ?)",
    ).run(
      "*/5 * * * *",
      legacyValid.id,
      legacyValidTrigger.id,
      legacyInvalidTrigger.id,
      legacyMissingPayload.id,
    );
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.trigger', json(?)) WHERE job_id = ?",
    ).run(JSON.stringify({ script: "true" }), legacyValidTrigger.id);
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.trigger', json(?)) WHERE job_id = ?",
    ).run(JSON.stringify({}), legacyInvalidTrigger.id);
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_remove(job_json, '$.payload') WHERE job_id = ?",
    ).run(legacyMissingPayload.id);
    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const expectedActiveJobIds = [legacyValid.id, legacyValidTrigger.id, surviving.id];
    expect(state.store?.jobs.map((job) => job.id)).toEqual(expectedActiveJobIds);
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(
      expectedActiveJobIds,
    );
    expect(await cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual([
      expect.objectContaining({
        sourceIndex: 0,
        reason: "invalid-schedule",
        job: expect.objectContaining({ id: malformed.id }),
      }),
      expect.objectContaining({
        sourceIndex: 3,
        reason: "invalid-trigger",
        job: expect.objectContaining({ id: legacyInvalidTrigger.id }),
      }),
      expect.objectContaining({
        sourceIndex: 4,
        reason: "missing-payload",
        job: expect.objectContaining({ id: legacyMissingPayload.id }),
      }),
    ]);
    await expectPathMissing(storePath.replace(/\.json$/, "-quarantine.json"));
  });

  it("quarantines malformed job and state JSON with exact recovery bytes", async () => {
    const { storePath } = await makeStorePath();
    const malformedJob = createReloadCronJob({ id: "malformed-job-json" });
    const malformedState = createReloadCronJob({ id: "malformed-state-json" });
    const surviving = createReloadCronJob({ id: "surviving-json-row" });
    await saveCronStore(storePath, {
      version: 1,
      jobs: [malformedJob, malformedState, surviving],
    });
    const db = openOpenClawStateDatabase().db;
    const stateRow = db
      .prepare("SELECT job_json FROM cron_jobs WHERE job_id = ?")
      .get(malformedState.id) as { job_json: string };
    db.prepare("UPDATE cron_jobs SET job_json = ? WHERE job_id = ?").run("{", malformedJob.id);
    db.prepare("UPDATE cron_jobs SET state_json = ? WHERE job_id = ?").run("[]", malformedState.id);
    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    expect(state.store?.jobs.map((job) => job.id)).toEqual([surviving.id]);
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([surviving.id]);
    expect(await cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual([
      expect.objectContaining({
        sourceIndex: 0,
        reason: "invalid-payload",
        raw: { jobId: malformedJob.id, jobJson: "{", stateJson: "{}" },
      }),
      expect.objectContaining({
        sourceIndex: 1,
        reason: "invalid-state",
        job: expect.objectContaining({ id: malformedState.id }),
        raw: { jobId: malformedState.id, jobJson: stateRow.job_json, stateJson: "[]" },
      }),
    ]);
  });

  it("quarantines persisted every schedules that cannot produce valid Date timestamps", async () => {
    const { storePath } = await makeStorePath();
    const invalidInterval = createReloadCronJob({
      id: "invalid-date-interval",
      schedule: { kind: "every", everyMs: 1_000 },
    });
    const invalidAnchor = createReloadCronJob({
      id: "invalid-date-anchor",
      schedule: { kind: "every", everyMs: 1_000, anchorMs: 0 },
    });
    const unsatisfiableInterval = createReloadCronJob({
      id: "unsatisfiable-date-interval",
      schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS },
    });
    const disabledUnsatisfiableInterval = createReloadCronJob({
      id: "disabled-unsatisfiable-date-interval",
      enabled: false,
      schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS },
    });
    const invalidStagger = createReloadCronJob({ id: "invalid-date-stagger" });
    const repairableState = createReloadCronJob({
      id: "repairable-runtime-state",
      state: { lastRunAtMs: MAX_DATE_TIMESTAMP_MS },
    });
    const surviving = createReloadCronJob({ id: "valid-schedule" });
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        invalidInterval,
        invalidAnchor,
        unsatisfiableInterval,
        disabledUnsatisfiableInterval,
        invalidStagger,
        repairableState,
        surviving,
      ],
    });
    const db = openOpenClawStateDatabase().db;
    // Number bindings become SQLite FLOATs; JSON formatting can round max + 1
    // back into the valid Date domain. Inject exact numeric JSON instead.
    const invalidTimestampJson = JSON.stringify(MAX_DATE_TIMESTAMP_MS + 1);
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.schedule.everyMs', json(?)) WHERE job_id = ?",
    ).run(invalidTimestampJson, invalidInterval.id);
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.schedule.anchorMs', json(?)) WHERE job_id = ?",
    ).run(invalidTimestampJson, invalidAnchor.id);
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.schedule.staggerMs', json(?)) WHERE job_id = ?",
    ).run(invalidTimestampJson, invalidStagger.id);
    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    expect(state.store?.jobs.map((job) => job.id)).toEqual([
      disabledUnsatisfiableInterval.id,
      repairableState.id,
      surviving.id,
    ]);
    expect(await cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual([
      expect.objectContaining({
        sourceIndex: 0,
        reason: "invalid-schedule",
        job: expect.objectContaining({
          id: invalidInterval.id,
          schedule: expect.objectContaining({ everyMs: MAX_DATE_TIMESTAMP_MS + 1 }),
        }),
      }),
      expect.objectContaining({
        sourceIndex: 1,
        reason: "invalid-schedule",
        job: expect.objectContaining({
          id: invalidAnchor.id,
          schedule: expect.objectContaining({ anchorMs: MAX_DATE_TIMESTAMP_MS + 1 }),
        }),
      }),
      expect.objectContaining({
        sourceIndex: 2,
        reason: "unsatisfiable-schedule",
        job: expect.objectContaining({ id: unsatisfiableInterval.id }),
      }),
      expect.objectContaining({
        sourceIndex: 4,
        reason: "invalid-schedule",
        job: expect.objectContaining({
          id: invalidStagger.id,
          schedule: expect.objectContaining({ staggerMs: MAX_DATE_TIMESTAMP_MS + 1 }),
        }),
      }),
    ]);
  });

  it("quarantines persisted runtime timestamps outside the Date domain", async () => {
    const { storePath } = await makeStorePath();
    const invalidState = createReloadCronJob({ id: "invalid-runtime-state" });
    const surviving = createReloadCronJob({ id: "valid-runtime-state" });
    await saveCronStore(storePath, { version: 1, jobs: [invalidState, surviving] });
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE cron_jobs SET state_json = json_set(state_json, '$.lastRunAtMs', json(?)) WHERE job_id = ?",
      )
      .run(JSON.stringify(MAX_DATE_TIMESTAMP_MS + 1), invalidState.id);
    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    expect(state.store?.jobs.map((job) => job.id)).toEqual([surviving.id]);
    expect(await cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual([
      expect.objectContaining({
        reason: "invalid-state",
        job: expect.objectContaining({ id: invalidState.id }),
        state: expect.objectContaining({ lastRunAtMs: MAX_DATE_TIMESTAMP_MS + 1 }),
      }),
    ]);
  });

  it("retains malformed rows and their quarantine until a load repair commits", async () => {
    const { storePath } = await makeStorePath();
    const malformed = createReloadCronJob({ id: "quarantine-retry-job" });
    const surviving = createReloadCronJob({
      id: "quarantine-survivor",
      state: { nextRunAtMs: STORE_TEST_NOW + 60_000 },
    });
    await saveCronStore(storePath, { version: 1, jobs: [malformed, surviving] });
    const db = openOpenClawStateDatabase().db;
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.schedule.kind', ?) WHERE job_id = ?",
    ).run("unsupported", malformed.id);
    const readRows = () =>
      db
        .prepare(
          "SELECT job_id, job_json, state_json FROM cron_jobs WHERE store_key = ? ORDER BY job_id",
        )
        .all(cronStoreKey(storePath));
    const before = readRows();
    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    vi.spyOn(cronStoreModule, "saveCronJobsStoreWithRevision").mockRejectedValueOnce(
      new Error("quarantine unavailable"),
    );

    await ensureLoaded(state);

    expect(readRows()).toEqual(before);
    expect(state.store?.jobs.map((job) => job.id)).toEqual([surviving.id]);
    expect(state.pendingQuarantineConfigJobs).toHaveLength(1);
    expect(await cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual([]);
    expect(onEvent).not.toHaveBeenCalled();

    await ensureLoaded(state, { forceReload: true });

    expect(readRows().map((row) => row.job_id)).toEqual([surviving.id]);
    expect(state.pendingQuarantineConfigJobs).toEqual([]);
    expect(await cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual([
      expect.objectContaining({
        reason: "invalid-schedule",
        job: expect.objectContaining({ id: malformed.id }),
      }),
    ]);
    expect(state.durableNextRunAtMsByJobId.get(surviving.id)).toBe(surviving.state.nextRunAtMs);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("does not let quarantine recovery bypass an active receipt fence", async () => {
    const { storePath } = await makeStorePath();
    const job = createReloadCronJob({ id: "quarantined-receipt-conflict", agentId: "alpha" });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const state = createStoreTestState(storePath);
    await ensureLoaded(state);
    const prepared = prepareCronRunReceiptClaim({
      observed: undefined,
      storePath,
      job,
      agentId: "alpha",
      startedAtMs: STORE_TEST_NOW,
    });
    const receipt = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabaseForTest({
        database: db,
        prepared,
        resolveAgentId: (current) => current.agentId!,
      }),
    );
    const snapshot = snapshotStoreForRollback(state);
    const ownerMutation = await prepareCronRunReceiptOwnerMutation({
      state,
      previousJob: job,
      nextJob: { ...job, agentId: "beta" },
    });
    findJobOrThrow(state, job.id).agentId = "beta";
    state.pendingQuarantineConfigJobs = [
      { sourceIndex: 0, reason: "invalid-schedule", job: { id: "quarantined-job" } },
    ];

    try {
      await expect(
        persistCronJobMutation({
          state,
          source: captureCronJobMutationSource(state),
          previous: snapshot.store!,
          next: state.store!,
          method: "cron.update",
          assertCurrent: ownerMutation?.assertCurrent,
          receiptMutation: {
            jobId: job.id,
            owner: ownerMutation?.prepared,
            triggerStateChanged: false,
            scheduleChanged: false,
          },
        }),
      ).rejects.toBeInstanceOf(CronRunReceiptConflictError);
      expect((await loadCronStore(storePath)).jobs[0]?.agentId).toBe("alpha");
      expect(state.pendingQuarantineConfigJobs).toHaveLength(1);
    } finally {
      await finishCronRunReceiptAsync({
        handle: receipt,
        status: "superseded",
        finishedAtMs: STORE_TEST_NOW + 1,
      });
    }
  });

  it("uses the trimmed canonical id for job rows and companion authority", async () => {
    const { storePath } = await makeStorePath();
    const rawJob = {
      id: "  repro-stable-id  ",
      jobId: "ignored-obsolete-alias",
      name: "handed",
      enabled: true,
      createdAtMs: STORE_TEST_NOW - 60_000,
      updatedAtMs: STORE_TEST_NOW - 60_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "tick", toolsAllow: [" read "] },
      runtimeAuthority: {
        version: 1,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [{ id: "calendar" }] },
      },
      state: {},
    };

    await writeSingleJobStore(storePath, rawJob);
    await writeSingleJobStore(storePath, rawJob);

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = findJobOrThrow(state, "repro-stable-id");
    expect(job.id).toBe("repro-stable-id");
    expect((job as { jobId?: unknown }).jobId).toBeUndefined();
    expect(job.payload).toMatchObject({ kind: "agentTurn", toolsAllow: ["read"] });
    expect(job.runtimeAuthority).toEqual({
      version: 1,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    });
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

    await ensureLoaded(state);

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
});
