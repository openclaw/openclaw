// Cron service store tests cover persisted service state loading and writes.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { pluginCommandSchedule } from "../plugin-command-schedule.test-support.js";
import { PLUGIN_COMMAND_SCHEDULE_MESSAGE } from "../plugin-command-schedule.types.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import * as cronStoreModule from "../store.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { createReloadCronJob, expectPathMissing, STORE_TEST_NOW } from "../store.test-support.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob } from "../types.js";
import { findJobOrThrow } from "./jobs-scheduling.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-store-seam",
});

async function writeJobStore(storePath: string, jobs: unknown[]) {
  await saveCronStore(storePath, { version: 1, jobs: jobs as CronJob[] });
}

function createStoreTestState(storePath: string, onEvent = vi.fn()) {
  return createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => STORE_TEST_NOW,
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    onEvent,
    onDefinitionChange: vi.fn(),
  });
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
      configRevisions: new Map(),
    });
    const read = vi
      .spyOn(cronStoreModule, "loadCronJobsStoreWithConfigJobsByKey")
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

  it("quarantines malformed SQLite rows atomically without creating JSON state", async () => {
    const { storePath } = await makeStorePath();
    const malformed = createReloadCronJob({ id: "malformed-sqlite-row" });
    const legacyValid = createReloadCronJob({ id: "legacy-valid" });
    const legacyValidTrigger = createReloadCronJob({ id: "legacy-valid-trigger" });
    const legacyInvalidTrigger = createReloadCronJob({ id: "legacy-invalid-trigger" });
    const legacyMissingPayload = createReloadCronJob({ id: "legacy-missing-payload" });
    const invalidProjection = {
      ...createReloadCronJob({ id: "invalid-projection" }),
      pluginCommand: pluginCommandSchedule(STORE_TEST_NOW),
      payload: {
        kind: "agentTurn" as const,
        message: PLUGIN_COMMAND_SCHEDULE_MESSAGE,
        toolsAllow: ["sessions_spawn", "agents_wait"],
      },
    };
    const surviving = createReloadCronJob({
      id: "surviving-sqlite-row",
      state: { nextRunAtMs: STORE_TEST_NOW + 60_000 },
    });
    await writeJobStore(storePath, [
      malformed,
      legacyValid,
      legacyValidTrigger,
      legacyInvalidTrigger,
      legacyMissingPayload,
      surviving,
      invalidProjection,
    ]);
    const db = openOpenClawStateDatabase().db;
    const setConfig = db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, ?, json(?)) WHERE job_id = ?",
    );
    for (const [jobId, field, value] of [
      [malformed.id, "$.schedule.kind", "unsupported"],
      [legacyValid.id, "$.schedule", "*/5 * * * *"],
      [legacyValidTrigger.id, "$.schedule", "*/5 * * * *"],
      [legacyInvalidTrigger.id, "$.schedule", "*/5 * * * *"],
      [legacyMissingPayload.id, "$.schedule", "*/5 * * * *"],
      [legacyValidTrigger.id, "$.trigger", { script: "true" }],
      [legacyInvalidTrigger.id, "$.trigger", {}],
      [invalidProjection.id, "$.payload.toolsAllow", [" "]],
    ] as const) {
      setConfig.run(field, JSON.stringify(value), jobId);
    }
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
    expect(await cronStoreModule.loadCronQuarantinedJobs(storePath)).toMatchObject([
      { sourceIndex: 0, reason: "invalid-schedule", job: { id: malformed.id } },
      { sourceIndex: 3, reason: "invalid-trigger", job: { id: legacyInvalidTrigger.id } },
      { sourceIndex: 4, reason: "missing-payload", job: { id: legacyMissingPayload.id } },
      { sourceIndex: 6, reason: "invalid-payload", job: { id: invalidProjection.id } },
    ]);
    await expectPathMissing(storePath.replace(/\.json$/, "-quarantine.json"));
  });

  it("quarantines unsatisfiable schedules and persisted timestamps outside the Date domain", async () => {
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
    const invalidState = createReloadCronJob({ id: "invalid-runtime-state" });
    await writeJobStore(storePath, [
      invalidInterval,
      invalidAnchor,
      unsatisfiableInterval,
      disabledUnsatisfiableInterval,
      invalidStagger,
      repairableState,
      surviving,
      invalidState,
    ]);
    const db = openOpenClawStateDatabase().db;
    // Number bindings become SQLite FLOATs; JSON formatting can round max + 1
    // back into the valid Date domain. Inject exact numeric JSON instead.
    const invalidTimestampJson = JSON.stringify(MAX_DATE_TIMESTAMP_MS + 1);
    const setSchedule = db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, ?, json(?)) WHERE job_id = ?",
    );
    for (const [job, field] of [
      [invalidInterval, "everyMs"],
      [invalidAnchor, "anchorMs"],
      [invalidStagger, "staggerMs"],
    ] as const) {
      setSchedule.run(`$.schedule.${field}`, invalidTimestampJson, job.id);
    }
    db.prepare(
      "UPDATE cron_jobs SET state_json = json_set(state_json, '$.lastRunAtMs', json(?)) WHERE job_id = ?",
    ).run(invalidTimestampJson, invalidState.id);
    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    expect(state.store?.jobs.map((job) => job.id)).toEqual([
      disabledUnsatisfiableInterval.id,
      repairableState.id,
      surviving.id,
    ]);
    expect(await cronStoreModule.loadCronQuarantinedJobs(storePath)).toMatchObject([
      {
        sourceIndex: 0,
        reason: "invalid-schedule",
        job: { id: invalidInterval.id, schedule: { everyMs: MAX_DATE_TIMESTAMP_MS + 1 } },
      },
      {
        sourceIndex: 1,
        reason: "invalid-schedule",
        job: { id: invalidAnchor.id, schedule: { anchorMs: MAX_DATE_TIMESTAMP_MS + 1 } },
      },
      { sourceIndex: 2, reason: "unsatisfiable-schedule", job: { id: unsatisfiableInterval.id } },
      {
        sourceIndex: 4,
        reason: "invalid-schedule",
        job: { id: invalidStagger.id, schedule: { staggerMs: MAX_DATE_TIMESTAMP_MS + 1 } },
      },
      {
        reason: "invalid-state",
        job: { id: invalidState.id },
        state: { lastRunAtMs: MAX_DATE_TIMESTAMP_MS + 1 },
      },
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
    vi.spyOn(cronStoreModule, "saveCronJobsStoreWithRevisionByKey").mockRejectedValueOnce(
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
    expect(await cronStoreModule.loadCronQuarantinedJobs(storePath)).toMatchObject([
      { reason: "invalid-schedule", job: { id: malformed.id } },
    ]);
    expect(state.durableNextRunAtMsByJobId.get(surviving.id)).toBe(surviving.state.nextRunAtMs);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("uses the trimmed canonical id for job rows and companion authority", async () => {
    const { storePath } = await makeStorePath();
    const rawJob = {
      ...createReloadCronJob({
        id: "  repro-stable-id  ",
        name: "handed",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "tick", toolsAllow: [" read "] },
      }),
      jobId: "ignored-obsolete-alias",
      runtimeAuthority: {
        version: 1,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [{ id: "calendar" }] },
      },
    };

    await writeJobStore(storePath, [rawJob]);
    await writeJobStore(storePath, [rawJob]);

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = findJobOrThrow(state, "repro-stable-id");
    expect(job.id).toBe("repro-stable-id");
    expect((job as { jobId?: unknown }).jobId).toBeUndefined();
    expect(job.payload).toMatchObject({ kind: "agentTurn", toolsAllow: ["read"] });
    expect(job.runtimeAuthority).toEqual(rawJob.runtimeAuthority);
    await expectPathMissing(`${storePath}.migrated`);
  });

  it("loads opaque session ids and preserves lazy errors for malformed persisted ids", async () => {
    const { storePath } = await makeStorePath();
    const sessionTarget = "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";

    await writeJobStore(storePath, [
      createReloadCronJob({
        id: "opaque-session-target-job",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget,
        payload: { kind: "agentTurn", message: "ping" },
      }),
    ]);

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = findJobOrThrow(state, "opaque-session-target-job");
    expect(job.sessionTarget).toBe(sessionTarget);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "opaque-session-target-job" }),
      expect.stringContaining("invalid persisted sessionTarget"),
    );

    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, '$.sessionTarget', ?) WHERE job_id = ?",
      )
      .run("session:bad\0id", job.id);
    const malformed = createStoreTestState(storePath);
    await expect(ensureLoaded(malformed)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: job.id }),
      expect.stringContaining("invalid persisted sessionTarget"),
    );
    await expect(ensureLoaded(malformed, { forceReload: true })).rejects.toThrow(
      "invalid cron sessionTarget session id",
    );
  });
});
