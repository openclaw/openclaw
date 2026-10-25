// Cron service store tests cover persisted service state loading and writes.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
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
  });
}

describe("cron service store seam coverage", () => {
  let storePath: string;
  let state: ReturnType<typeof createStoreTestState>;
  beforeEach(async () => {
    ({ storePath } = await makeStorePath());
    state = createStoreTestState(storePath);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const seed = (...jobs: CronJob[]) => saveCronStore(storePath, { version: 1, jobs });
  const jobIds = () => state.store?.jobs.map((job) => job.id);
  const quarantined = () => cronStoreModule.loadCronQuarantinedJobs(storePath);
  const rejected = (sourceIndex: number, reason: string, job: Partial<CronJob>) =>
    expect.objectContaining({ sourceIndex, reason, job: expect.objectContaining(job) });
  function corrupt(id: string, field: string, value: unknown) {
    openOpenClawStateDatabase()
      .db.prepare("UPDATE cron_jobs SET job_json = json_set(job_json, ?, json(?)) WHERE job_id = ?")
      .run(`$.${field}`, JSON.stringify(value), id);
  }

  it("keeps a loaded snapshot stale when a writer advances its revision during loading", async () => {
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

  it("quarantines malformed SQLite rows atomically without creating JSON state", async () => {
    const malformed = createReloadCronJob({ id: "malformed-sqlite-row" });
    const legacyValid = createReloadCronJob({ id: "legacy-valid" });
    const legacyValidTrigger = createReloadCronJob({ id: "legacy-valid-trigger" });
    const legacyInvalidTrigger = createReloadCronJob({ id: "legacy-invalid-trigger" });
    const legacyMissingPayload = createReloadCronJob({ id: "legacy-missing-payload" });
    const surviving = createReloadCronJob({
      id: "surviving-sqlite-row",
      state: { nextRunAtMs: STORE_TEST_NOW + 60_000 },
    });
    await seed(
      malformed,
      legacyValid,
      legacyValidTrigger,
      legacyInvalidTrigger,
      legacyMissingPayload,
      surviving,
    );
    const db = openOpenClawStateDatabase().db;
    corrupt(malformed.id, "schedule.kind", "unsupported");
    for (const job of [
      legacyValid,
      legacyValidTrigger,
      legacyInvalidTrigger,
      legacyMissingPayload,
    ]) {
      corrupt(job.id, "schedule", "*/5 * * * *");
    }
    corrupt(legacyValidTrigger.id, "trigger", { script: "true" });
    corrupt(legacyInvalidTrigger.id, "trigger", {});
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_remove(job_json, '$.payload') WHERE job_id = ?",
    ).run(legacyMissingPayload.id);
    await ensureLoaded(state);

    const expectedActiveJobIds = [legacyValid.id, legacyValidTrigger.id, surviving.id];
    expect(jobIds()).toEqual(expectedActiveJobIds);
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(
      expectedActiveJobIds,
    );
    expect(await quarantined()).toEqual([
      rejected(0, "invalid-schedule", { id: malformed.id }),
      rejected(3, "invalid-trigger", { id: legacyInvalidTrigger.id }),
      rejected(4, "missing-payload", { id: legacyMissingPayload.id }),
    ]);
    await expectPathMissing(storePath.replace(/\.json$/, "-quarantine.json"));
  });

  it("quarantines persisted every schedules that cannot produce valid Date timestamps", async () => {
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
    await seed(
      invalidInterval,
      invalidAnchor,
      unsatisfiableInterval,
      disabledUnsatisfiableInterval,
      invalidStagger,
      repairableState,
      surviving,
    );
    // Number bindings become SQLite FLOATs; JSON formatting can round max + 1
    // back into the valid Date domain. Inject exact numeric JSON instead.
    const invalidTimestamp = MAX_DATE_TIMESTAMP_MS + 1;
    corrupt(invalidInterval.id, "schedule.everyMs", invalidTimestamp);
    corrupt(invalidAnchor.id, "schedule.anchorMs", invalidTimestamp);
    corrupt(invalidStagger.id, "schedule.staggerMs", invalidTimestamp);

    await ensureLoaded(state);

    expect(jobIds()).toEqual([disabledUnsatisfiableInterval.id, repairableState.id, surviving.id]);
    expect(await quarantined()).toEqual([
      rejected(0, "invalid-schedule", {
        id: invalidInterval.id,
        schedule: expect.objectContaining({ everyMs: invalidTimestamp }),
      }),
      rejected(1, "invalid-schedule", {
        id: invalidAnchor.id,
        schedule: expect.objectContaining({ anchorMs: invalidTimestamp }),
      }),
      rejected(2, "unsatisfiable-schedule", { id: unsatisfiableInterval.id }),
      rejected(4, "invalid-schedule", {
        id: invalidStagger.id,
        schedule: expect.objectContaining({ staggerMs: invalidTimestamp }),
      }),
    ]);
  });

  it("quarantines persisted runtime timestamps outside the Date domain", async () => {
    const invalidState = createReloadCronJob({ id: "invalid-runtime-state" });
    const surviving = createReloadCronJob({ id: "valid-runtime-state" });
    await seed(invalidState, surviving);
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE cron_jobs SET state_json = json_set(state_json, '$.lastRunAtMs', json(?)) WHERE job_id = ?",
      )
      .run(JSON.stringify(MAX_DATE_TIMESTAMP_MS + 1), invalidState.id);

    await ensureLoaded(state);

    expect(jobIds()).toEqual([surviving.id]);
    expect(await quarantined()).toEqual([
      expect.objectContaining({
        reason: "invalid-state",
        job: expect.objectContaining({ id: invalidState.id }),
        state: expect.objectContaining({ lastRunAtMs: MAX_DATE_TIMESTAMP_MS + 1 }),
      }),
    ]);
  });

  it("retains malformed rows and their quarantine until a load repair commits", async () => {
    const malformed = createReloadCronJob({ id: "quarantine-retry-job" });
    const surviving = createReloadCronJob({
      id: "quarantine-survivor",
      state: { nextRunAtMs: STORE_TEST_NOW + 60_000 },
    });
    await seed(malformed, surviving);
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
    state = createStoreTestState(storePath, onEvent);
    vi.spyOn(cronStoreModule, "saveCronJobsStoreWithRevision").mockRejectedValueOnce(
      new Error("quarantine unavailable"),
    );

    await ensureLoaded(state);

    expect(readRows()).toEqual(before);
    expect(jobIds()).toEqual([surviving.id]);
    expect(state.pendingQuarantineConfigJobs).toHaveLength(1);
    expect(await quarantined()).toEqual([]);
    expect(onEvent).not.toHaveBeenCalled();

    await ensureLoaded(state, { forceReload: true });

    expect(readRows().map((row) => row.job_id)).toEqual([surviving.id]);
    expect(state.pendingQuarantineConfigJobs).toEqual([]);
    expect(await quarantined()).toEqual([
      expect.objectContaining({
        reason: "invalid-schedule",
        job: expect.objectContaining({ id: malformed.id }),
      }),
    ]);
    expect(state.durableNextRunAtMsByJobId.get(surviving.id)).toBe(surviving.state.nextRunAtMs);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("uses the trimmed canonical id for job rows and companion authority", async () => {
    const rawJob = {
      ...createReloadCronJob({
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "tick", toolsAllow: [" read "] },
      }),
      id: "  repro-stable-id  ",
      jobId: "ignored-obsolete-alias",
      name: "handed",
      runtimeAuthority: {
        version: 1,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [{ id: "calendar" }] },
      },
    } satisfies CronJob & { jobId: string };

    await seed(rawJob);
    await seed(rawJob);

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

  it("loads persisted jobs with opaque custom session ids containing separators", async () => {
    const sessionTarget = "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";

    await seed(
      createReloadCronJob({
        id: "opaque-session-target-job",
        name: "opaque session target job",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget,
        payload: { kind: "agentTurn", message: "ping" },
      }),
    );

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
