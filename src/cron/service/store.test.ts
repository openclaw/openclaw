// Cron service store tests cover persisted service state loading and writes.
import fs from "node:fs/promises";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import * as cronStoreModule from "../store.js";
import { loadCronStore, saveCronStore } from "../store.js";
import {
  claimCronRunReceiptInDatabase,
  CronRunReceiptConflictError,
  finishCronRunReceipt,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.js";
import type { CronJob } from "../types.js";
import { findJobOrThrow } from "./jobs-scheduling.js";
import { cronNotificationJob, type CronNotificationIntent } from "./notification-intents.js";
import { cronRunReceiptMutationHooks } from "./run-receipts.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded, persist, persistOrRestore, snapshotStoreForRollback } from "./store.js";

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
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => STORE_TEST_NOW,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
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
function createPostPersistNotification(job = createReloadCronJob()): CronNotificationIntent {
  return { kind: "auto-disabled", job: cronNotificationJob(job), text: "auto-disabled notice" };
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

  it("does not drain post-persist notifications when there is no store to write", async () => {
    const { storePath } = await makeStorePath();
    const state = createStoreTestState(storePath);
    const notify = vi.mocked(state.deps.enqueueSystemEvent);

    await expect(
      persist(state, { postPersistNotifications: [createPostPersistNotification()] }),
    ).resolves.toBe(false);

    expect(notify).not.toHaveBeenCalled();
  });

  it.each(["full", "changed"] as const)(
    "reloads a later committed value after a %s save publishes its own revision",
    async (kind) => {
      const { storePath } = await makeStorePath();
      await writeSingleJobStore(storePath, createReloadCronJob());
      const state = createStoreTestState(storePath);
      await ensureLoaded(state);
      const snapshot = snapshotStoreForRollback(state);
      findJobOrThrow(state, "reload-cron-expr-job").name = "first save";
      const withLaterWrite = async <Value>(save: Promise<Value>): Promise<Value> => {
        const committed = await save;
        const later = await loadCronStore(storePath);
        later.jobs[0]!.name = "later committed save";
        await saveCronStore(storePath, later);
        return committed;
      };
      if (kind === "full") {
        const save = cronStoreModule.saveCronJobsStoreWithRevision;
        vi.spyOn(cronStoreModule, "saveCronJobsStoreWithRevision").mockImplementationOnce(
          (...args) => withLaterWrite(save(...args)),
        );
        await persist(state);
      } else {
        state.deps.cronEnabled = false;
        const save = cronStoreModule.saveCronJobsStoreChangesWithRevision;
        vi.spyOn(cronStoreModule, "saveCronJobsStoreChangesWithRevision").mockImplementationOnce(
          (...args) => withLaterWrite(save(...args)),
        );
        await persistOrRestore(state, snapshot);
      }
      expect(state.store?.jobs[0]?.name).toBe("first save");
      await ensureLoaded(state);
      expect(state.store?.jobs[0]?.name).toBe("later committed save");
    },
  );

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

    await persist(state);
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
    expect(cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual([
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
    expect(cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual([
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
    expect(cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual([
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
    expect(cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual([
      expect.objectContaining({
        reason: "invalid-state",
        job: expect.objectContaining({ id: invalidState.id }),
        state: expect.objectContaining({ lastRunAtMs: MAX_DATE_TIMESTAMP_MS + 1 }),
      }),
    ]);
  });

  it("publishes durable wake changes only after save and exactly once after retry", async () => {
    const { storePath } = await makeStorePath();
    const initialNextRunAtMs = STORE_TEST_NOW + 60_000;
    const changedNextRunAtMs = STORE_TEST_NOW + 120_000;
    await writeSingleJobStore(
      storePath,
      createReloadCronJob({
        id: "durable-wake-job",
        state: { nextRunAtMs: initialNextRunAtMs },
      }),
    );
    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state);
    const job = findJobOrThrow(state, "durable-wake-job");
    job.state.nextRunAtMs = changedNextRunAtMs;

    vi.spyOn(cronStoreModule, "saveCronJobsStoreWithRevision").mockRejectedValueOnce(
      new Error("disk full"),
    );
    await expect(persist(state)).rejects.toThrow("disk full");

    expect(onEvent).not.toHaveBeenCalled();
    expect(state.durableNextRunAtMsByJobId.get(job.id)).toBe(initialNextRunAtMs);

    await persist(state);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: job.id,
        nextRunAtMs: changedNextRunAtMs,
      }),
    );
    expect(state.durableNextRunAtMsByJobId.get(job.id)).toBe(changedNextRunAtMs);

    await persist(state);
    expect(onEvent).toHaveBeenCalledTimes(1);

    job.state.nextRunAtMs = undefined;
    await persist(state);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: job.id,
        nextRunAtMs: undefined,
      }),
    );
    expect(state.durableNextRunAtMsByJobId.has(job.id)).toBe(true);
    expect(state.durableNextRunAtMsByJobId.get(job.id)).toBeUndefined();
  });

  it("drains post-persist notifications only after a successful state-only write", async () => {
    const { storePath } = await makeStorePath();
    await writeSingleJobStore(storePath, createReloadCronJob());
    const state = createStoreTestState(storePath);
    await ensureLoaded(state);
    const notify = vi.mocked(state.deps.enqueueSystemEvent);
    const order: string[] = [];
    const saveCronJobsStoreWithRevision = cronStoreModule.saveCronJobsStoreWithRevision;
    vi.spyOn(cronStoreModule, "saveCronJobsStoreWithRevision")
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementationOnce(async (...args) => {
        expect(notify).not.toHaveBeenCalled();
        const committed = await saveCronJobsStoreWithRevision(...args);
        order.push("persist");
        return committed;
      });
    notify.mockImplementation(() => {
      order.push("notify");
    });
    const postPersistNotifications = [createPostPersistNotification()];

    await expect(persist(state, { stateOnly: true, postPersistNotifications })).rejects.toThrow(
      "disk full",
    );
    expect(notify).not.toHaveBeenCalled();

    await persist(state, { stateOnly: true, postPersistNotifications });

    expect(order).toEqual(["persist", "notify"]);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("contains a throwing post-persist notification without dropping siblings or the write", async () => {
    // A notification failure happens after the durable commit: it must not
    // reject the persist, skip sibling notifications, or roll back the store.
    const { storePath } = await makeStorePath();
    const nextRunAtMs = STORE_TEST_NOW + 120_000;
    await writeSingleJobStore(storePath, createReloadCronJob());
    const state = createStoreTestState(storePath);
    await ensureLoaded(state);
    const snapshot = snapshotStoreForRollback(state);
    const job = findJobOrThrow(state, "reload-cron-expr-job");
    job.state.nextRunAtMs = nextRunAtMs;
    const siblingNotify = vi.fn();
    vi.mocked(state.deps.enqueueSystemEvent)
      .mockImplementationOnce(() => {
        throw new Error("notification failed");
      })
      .mockImplementationOnce(siblingNotify);

    await persistOrRestore(state, snapshot, {
      postPersistNotifications: [
        createPostPersistNotification(job),
        createPostPersistNotification(job),
      ],
    });

    expect(siblingNotify).toHaveBeenCalledOnce();
    expect(job.state.nextRunAtMs).toBe(nextRunAtMs);
    expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(nextRunAtMs);
  });

  it("advances durable wake state while suppressing duplicate scheduled delivery", async () => {
    const { storePath } = await makeStorePath();
    const initialNextRunAtMs = STORE_TEST_NOW + 60_000;
    const suppressedNextRunAtMs = STORE_TEST_NOW + 120_000;
    const publishedNextRunAtMs = STORE_TEST_NOW + 180_000;
    await writeSingleJobStore(
      storePath,
      createReloadCronJob({
        id: "suppressed-scheduled-job",
        state: { nextRunAtMs: initialNextRunAtMs },
      }),
    );
    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state);
    const job = findJobOrThrow(state, "suppressed-scheduled-job");

    job.state.nextRunAtMs = suppressedNextRunAtMs;
    await persist(state, { suppressScheduledJobId: job.id });

    expect(onEvent).not.toHaveBeenCalled();
    expect(state.durableNextRunAtMsByJobId.get(job.id)).toBe(suppressedNextRunAtMs);

    job.state.nextRunAtMs = publishedNextRunAtMs;
    await persist(state);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: job.id,
        nextRunAtMs: publishedNextRunAtMs,
      }),
    );
  });

  it("does not publish scheduled events for full-save topology changes", async () => {
    const { storePath } = await makeStorePath();
    const firstNextRunAtMs = STORE_TEST_NOW + 60_000;
    const readdedNextRunAtMs = STORE_TEST_NOW + 180_000;
    await writeSingleJobStore(
      storePath,
      createReloadCronJob({
        id: "existing-job",
        state: { nextRunAtMs: firstNextRunAtMs },
      }),
    );
    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state);
    if (!state.store) {
      throw new Error("expected loaded cron store");
    }

    const topologyJob = createReloadCronJob({
      id: "topology-job",
      state: { nextRunAtMs: STORE_TEST_NOW + 120_000 },
    });
    state.store.jobs.push(topologyJob);
    await persist(state);
    expect(onEvent).not.toHaveBeenCalled();
    expect(state.durableNextRunAtMsByJobId.has(topologyJob.id)).toBe(true);

    state.store.jobs = state.store.jobs.filter((job) => job.id !== topologyJob.id);
    await persist(state);
    expect(onEvent).not.toHaveBeenCalled();
    expect(state.durableNextRunAtMsByJobId.has(topologyJob.id)).toBe(false);

    const readdedJob = createReloadCronJob({
      id: topologyJob.id,
      state: { nextRunAtMs: readdedNextRunAtMs },
    });
    state.store.jobs.push(readdedJob);
    await persist(state);
    expect(onEvent).not.toHaveBeenCalled();

    readdedJob.state.nextRunAtMs = readdedNextRunAtMs + 60_000;
    await persist(state);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: topologyJob.id,
        nextRunAtMs: readdedNextRunAtMs + 60_000,
      }),
    );
  });

  it("keeps state-only wake publication aligned with persisted topology", async () => {
    const { storePath } = await makeStorePath();
    const initialNextRunAtMs = STORE_TEST_NOW + 60_000;
    const changedNextRunAtMs = STORE_TEST_NOW + 180_000;
    await writeSingleJobStore(
      storePath,
      createReloadCronJob({
        id: "durable-state-only-job",
        state: { nextRunAtMs: initialNextRunAtMs },
      }),
    );
    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state);
    if (!state.store) {
      throw new Error("expected loaded cron store");
    }

    state.store.jobs = [
      createReloadCronJob({
        id: "new-state-only-job",
        state: { nextRunAtMs: STORE_TEST_NOW + 120_000 },
      }),
    ];
    await persist(state, { stateOnly: true });

    expect(onEvent).not.toHaveBeenCalled();
    expect([...state.durableNextRunAtMsByJobId.keys()]).toEqual(["durable-state-only-job"]);
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([
      "durable-state-only-job",
    ]);

    state.store.jobs = [
      createReloadCronJob({
        id: "durable-state-only-job",
        state: { nextRunAtMs: changedNextRunAtMs },
      }),
    ];
    await persist(state, { stateOnly: true });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: "durable-state-only-job",
        nextRunAtMs: changedNextRunAtMs,
      }),
    );
    expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(changedNextRunAtMs);
  });

  it("does not advance durable wake state when quarantine prevents a save", async () => {
    const { storePath } = await makeStorePath();
    const initialNextRunAtMs = STORE_TEST_NOW + 60_000;
    const changedNextRunAtMs = STORE_TEST_NOW + 120_000;
    await writeSingleJobStore(
      storePath,
      createReloadCronJob({
        id: "quarantine-retry-job",
        state: { nextRunAtMs: initialNextRunAtMs },
      }),
    );
    const onEvent = vi.fn();
    const state = createStoreTestState(storePath, onEvent);
    await ensureLoaded(state);
    const job = findJobOrThrow(state, "quarantine-retry-job");
    job.state.nextRunAtMs = changedNextRunAtMs;
    state.pendingQuarantineConfigJobs = [
      { sourceIndex: 0, reason: "invalid-schedule", job: { id: "quarantined-job" } },
    ];
    const saveStore = vi
      .spyOn(cronStoreModule, "saveCronJobsStoreWithRevision")
      .mockRejectedValueOnce(new Error("quarantine unavailable"));
    const notify = vi.mocked(state.deps.enqueueSystemEvent);
    const postPersistNotifications = [createPostPersistNotification()];

    await persist(state, { stateOnly: true, postPersistNotifications });

    expect(saveStore).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(state.pendingQuarantineConfigJobs).toHaveLength(1);
    expect(state.durableNextRunAtMsByJobId.get(job.id)).toBe(initialNextRunAtMs);
    expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(initialNextRunAtMs);

    await persist(state, { stateOnly: true, postPersistNotifications });

    expect(saveStore).toHaveBeenLastCalledWith(
      storePath,
      state.store,
      expect.objectContaining({
        quarantine: expect.objectContaining({
          entries: [expect.objectContaining({ reason: "invalid-schedule" })],
        }),
      }),
    );
    expect(state.pendingQuarantineConfigJobs).toEqual([]);
    expect(notify).toHaveBeenCalledOnce();
    expect(cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual([
      expect.objectContaining({ reason: "invalid-schedule" }),
    ]);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "scheduled",
        jobId: job.id,
        nextRunAtMs: changedNextRunAtMs,
      }),
    );
    expect((await loadCronStore(storePath)).jobs[0]?.state.nextRunAtMs).toBe(changedNextRunAtMs);
  });

  it("does not let quarantine recovery bypass an active receipt fence", async () => {
    const { storePath } = await makeStorePath();
    const job = createReloadCronJob({ id: "quarantined-receipt-conflict", agentId: "alpha" });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const state = createStoreTestState(storePath);
    await ensureLoaded(state);
    const prepared = prepareCronRunReceiptClaim({
      storePath,
      job,
      agentId: "alpha",
      startedAtMs: STORE_TEST_NOW,
    });
    const receipt = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabase({
        database: db,
        prepared,
        resolveAgentId: (current) => current.agentId!,
      }),
    );
    const snapshot = snapshotStoreForRollback(state);
    findJobOrThrow(state, job.id).agentId = "beta";
    state.pendingQuarantineConfigJobs = [
      { sourceIndex: 0, reason: "invalid-schedule", job: { id: "quarantined-job" } },
    ];

    try {
      await expect(
        persistOrRestore(state, snapshot, {
          transactionHooks: cronRunReceiptMutationHooks({
            state,
            jobId: job.id,
            ownerChanged: true,
            triggerStateChanged: false,
          }),
        }),
      ).rejects.toBeInstanceOf(CronRunReceiptConflictError);
      expect((await loadCronStore(storePath)).jobs[0]?.agentId).toBe("alpha");
      expect(state.pendingQuarantineConfigJobs).toHaveLength(1);
    } finally {
      finishCronRunReceipt({
        handle: receipt,
        status: "superseded",
        finishedAtMs: STORE_TEST_NOW + 1,
      });
    }
  });

  it("uses the normalized stable id for job rows and companion authority", async () => {
    const { storePath } = await makeStorePath();
    const rawJob = {
      jobId: "repro-stable-id",
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
