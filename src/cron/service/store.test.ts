import fs from "node:fs/promises";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import * as cronStoreModule from "../store.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronJob } from "../types.js";
import { findJobOrThrow } from "./jobs-scheduling.js";
import { createCronServiceState } from "./state.js";
import { ensureLoaded } from "./store.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-service-store-seam",
});

const STORE_TEST_NOW = Date.parse("2026-03-23T12:00:00.000Z");

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function quarantined(sourceIndex: number, reason: string, id: string, schedule?: object) {
  return expect.objectContaining({
    sourceIndex,
    reason,
    job: expect.objectContaining({
      id,
      ...(schedule && { schedule: expect.objectContaining(schedule) }),
    }),
  });
}

function patchJobJson(id: string, field: string, value: unknown) {
  openOpenClawStateDatabase()
    .db.prepare("UPDATE cron_jobs SET job_json = json_set(job_json, ?, json(?)) WHERE job_id = ?")
    .run(`$.${field}`, JSON.stringify(value), id);
}

function createStoreTestState(storePath: string, onEvent = vi.fn()) {
  return createCronServiceState({
    scheduler: createTestGatewayScheduler(),
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

function createReloadCronJob(id: string, params?: Partial<CronJob>): CronJob {
  return {
    id,
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
async function writeJobs(storePath: string, ...jobs: CronJob[]) {
  await saveCronStore(storePath, { version: 1, jobs });
}
describe("cron service store seam coverage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a loaded snapshot stale when a writer advances its revision during loading", async () => {
    const { storePath } = await makeStorePath();
    const state = createStoreTestState(storePath);
    const first = createReloadCronJob("before-write");
    const second = createReloadCronJob("after-write");
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
    const { storePath } = await makeStorePath();
    const malformed = createReloadCronJob("malformed-sqlite-row");
    const legacyValid = createReloadCronJob("legacy-valid");
    const legacyValidTrigger = createReloadCronJob("legacy-valid-trigger");
    const legacyInvalidTrigger = createReloadCronJob("legacy-invalid-trigger");
    const legacyMissingPayload = createReloadCronJob("legacy-missing-payload");
    const surviving = createReloadCronJob("surviving-sqlite-row", {
      state: { nextRunAtMs: STORE_TEST_NOW + 60_000 },
    });
    await writeJobs(
      storePath,
      malformed,
      legacyValid,
      legacyValidTrigger,
      legacyInvalidTrigger,
      legacyMissingPayload,
      surviving,
    );
    const db = openOpenClawStateDatabase().db;
    patchJobJson(malformed.id, "schedule.kind", "unsupported");
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.schedule', ?) WHERE job_id IN (?, ?, ?, ?)",
    ).run(
      "*/5 * * * *",
      legacyValid.id,
      legacyValidTrigger.id,
      legacyInvalidTrigger.id,
      legacyMissingPayload.id,
    );
    patchJobJson(legacyValidTrigger.id, "trigger", { script: "true" });
    patchJobJson(legacyInvalidTrigger.id, "trigger", {});
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
      quarantined(0, "invalid-schedule", malformed.id),
      quarantined(3, "invalid-trigger", legacyInvalidTrigger.id),
      quarantined(4, "missing-payload", legacyMissingPayload.id),
    ]);
    await expectPathMissing(storePath.replace(/\.json$/, "-quarantine.json"));
  });

  it("quarantines persisted every schedules that cannot produce valid Date timestamps", async () => {
    const { storePath } = await makeStorePath();
    const invalidInterval = createReloadCronJob("invalid-date-interval", {
      schedule: { kind: "every", everyMs: 1_000 },
    });
    const invalidAnchor = createReloadCronJob("invalid-date-anchor", {
      schedule: { kind: "every", everyMs: 1_000, anchorMs: 0 },
    });
    const unsatisfiableInterval = createReloadCronJob("unsatisfiable-date-interval", {
      schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS },
    });
    const disabledUnsatisfiableInterval = createReloadCronJob(
      "disabled-unsatisfiable-date-interval",
      {
        enabled: false,
        schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS },
      },
    );
    const invalidStagger = createReloadCronJob("invalid-date-stagger");
    const repairableState = createReloadCronJob("repairable-runtime-state", {
      state: { lastRunAtMs: MAX_DATE_TIMESTAMP_MS },
    });
    const surviving = createReloadCronJob("valid-schedule");
    await writeJobs(
      storePath,
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
    patchJobJson(invalidInterval.id, "schedule.everyMs", invalidTimestamp);
    patchJobJson(invalidAnchor.id, "schedule.anchorMs", invalidTimestamp);
    patchJobJson(invalidStagger.id, "schedule.staggerMs", invalidTimestamp);
    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    expect(state.store?.jobs.map((job) => job.id)).toEqual([
      disabledUnsatisfiableInterval.id,
      repairableState.id,
      surviving.id,
    ]);
    expect(await cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual([
      quarantined(0, "invalid-schedule", invalidInterval.id, { everyMs: invalidTimestamp }),
      quarantined(1, "invalid-schedule", invalidAnchor.id, { anchorMs: invalidTimestamp }),
      quarantined(2, "unsatisfiable-schedule", unsatisfiableInterval.id),
      quarantined(4, "invalid-schedule", invalidStagger.id, { staggerMs: invalidTimestamp }),
    ]);
  });

  it("quarantines persisted runtime timestamps outside the Date domain", async () => {
    const { storePath } = await makeStorePath();
    const invalidState = createReloadCronJob("invalid-runtime-state");
    const surviving = createReloadCronJob("valid-runtime-state");
    await writeJobs(storePath, invalidState, surviving);
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
    const malformed = createReloadCronJob("quarantine-retry-job");
    const surviving = createReloadCronJob("quarantine-survivor", {
      state: { nextRunAtMs: STORE_TEST_NOW + 60_000 },
    });
    await writeJobs(storePath, malformed, surviving);
    const db = openOpenClawStateDatabase().db;
    patchJobJson(malformed.id, "schedule.kind", "unsupported");
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

  it("uses the trimmed canonical id for job rows and companion authority", async () => {
    const { storePath } = await makeStorePath();
    const runtimeAuthority = {
      version: 1 as const,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    const rawJob: CronJob & { jobId: string } = {
      ...createReloadCronJob("  repro-stable-id  "),
      name: "handed",
      jobId: "ignored-obsolete-alias",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "tick", toolsAllow: [" read "] },
      runtimeAuthority,
    };

    await writeJobs(storePath, rawJob);
    await writeJobs(storePath, rawJob);

    const state = createStoreTestState(storePath);

    await ensureLoaded(state);

    const job = findJobOrThrow(state, "repro-stable-id");
    expect(job.id).toBe("repro-stable-id");
    expect((job as { jobId?: unknown }).jobId).toBeUndefined();
    expect(job.payload).toMatchObject({ kind: "agentTurn", toolsAllow: ["read"] });
    expect(job.runtimeAuthority).toEqual(runtimeAuthority);
    await expectPathMissing(`${storePath}.migrated`);
  });

  it("loads persisted jobs with opaque custom session ids containing separators", async () => {
    const { storePath } = await makeStorePath();
    const sessionTarget = "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";

    await writeJobs(
      storePath,
      createReloadCronJob("opaque-session-target-job", {
        name: "opaque session target job",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget,
        payload: { kind: "agentTurn", message: "ping" },
      }),
    );

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
