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

const NOW = Date.parse("2026-03-23T12:00:00.000Z");

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

function makeState(storePath: string, onEvent = vi.fn()) {
  return createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    log: logger,
    nowMs: () => NOW,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    onEvent,
  });
}
async function loadState(storePath: string) {
  const state = makeState(storePath);
  await ensureLoaded(state);
  return state;
}
async function expectQuarantine(storePath: string, activeIds: string[], entries: unknown[]) {
  const state = await loadState(storePath);
  expect(state.store?.jobs.map((job) => job.id)).toEqual(activeIds);
  expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(activeIds);
  expect(await cronStoreModule.loadCronQuarantinedJobs(storePath)).toEqual(entries);
}

function makeJob(id: string, params?: Partial<CronJob>): CronJob {
  return {
    id,
    name: "reload cron expr job",
    enabled: true,
    createdAtMs: NOW - 60_000,
    updatedAtMs: NOW - 60_000,
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
    const state = makeState(storePath);
    const first = makeJob("before-write");
    const second = makeJob("after-write");
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
    const malformed = makeJob("malformed-sqlite-row");
    const legacyValid = makeJob("legacy-valid");
    const legacyValidTrigger = makeJob("legacy-valid-trigger");
    const legacyInvalidTrigger = makeJob("legacy-invalid-trigger");
    const legacyMissingPayload = makeJob("legacy-missing-payload");
    const surviving = makeJob("surviving-sqlite-row", {
      state: { nextRunAtMs: NOW + 60_000 },
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
    await expectQuarantine(
      storePath,
      [legacyValid.id, legacyValidTrigger.id, surviving.id],
      [
        quarantined(0, "invalid-schedule", malformed.id),
        quarantined(3, "invalid-trigger", legacyInvalidTrigger.id),
        quarantined(4, "missing-payload", legacyMissingPayload.id),
      ],
    );
    await expectPathMissing(storePath.replace(/\.json$/, "-quarantine.json"));
  });

  it("quarantines persisted every schedules that cannot produce valid Date timestamps", async () => {
    const { storePath } = await makeStorePath();
    const interval = makeJob("invalid-date-interval", {
      schedule: { kind: "every", everyMs: 1_000 },
    });
    const anchor = makeJob("invalid-date-anchor", {
      schedule: { kind: "every", everyMs: 1_000, anchorMs: 0 },
    });
    const hugeInterval = makeJob("unsatisfiable-date-interval", {
      schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS },
    });
    const disabledInterval = makeJob("disabled-unsatisfiable-date-interval", {
      enabled: false,
      schedule: { kind: "every", everyMs: MAX_DATE_TIMESTAMP_MS },
    });
    const stagger = makeJob("invalid-date-stagger");
    const repairable = makeJob("repairable-runtime-state", {
      state: { lastRunAtMs: MAX_DATE_TIMESTAMP_MS },
    });
    const surviving = makeJob("valid-schedule");
    await writeJobs(
      storePath,
      interval,
      anchor,
      hugeInterval,
      disabledInterval,
      stagger,
      repairable,
      surviving,
    );
    // Number bindings become SQLite FLOATs; JSON formatting can round max + 1
    // back into the valid Date domain. Inject exact numeric JSON instead.
    const invalidTimestamp = MAX_DATE_TIMESTAMP_MS + 1;
    patchJobJson(interval.id, "schedule.everyMs", invalidTimestamp);
    patchJobJson(anchor.id, "schedule.anchorMs", invalidTimestamp);
    patchJobJson(stagger.id, "schedule.staggerMs", invalidTimestamp);
    await expectQuarantine(
      storePath,
      [disabledInterval.id, repairable.id, surviving.id],
      [
        quarantined(0, "invalid-schedule", interval.id, { everyMs: invalidTimestamp }),
        quarantined(1, "invalid-schedule", anchor.id, { anchorMs: invalidTimestamp }),
        quarantined(2, "unsatisfiable-schedule", hugeInterval.id),
        quarantined(4, "invalid-schedule", stagger.id, { staggerMs: invalidTimestamp }),
      ],
    );
  });

  it("quarantines persisted runtime timestamps outside the Date domain", async () => {
    const { storePath } = await makeStorePath();
    const invalidState = makeJob("invalid-runtime-state");
    const surviving = makeJob("valid-runtime-state");
    await writeJobs(storePath, invalidState, surviving);
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE cron_jobs SET state_json = json_set(state_json, '$.lastRunAtMs', json(?)) WHERE job_id = ?",
      )
      .run(JSON.stringify(MAX_DATE_TIMESTAMP_MS + 1), invalidState.id);
    await expectQuarantine(
      storePath,
      [surviving.id],
      [
        expect.objectContaining({
          reason: "invalid-state",
          job: expect.objectContaining({ id: invalidState.id }),
          state: expect.objectContaining({ lastRunAtMs: MAX_DATE_TIMESTAMP_MS + 1 }),
        }),
      ],
    );
  });

  it("retains malformed rows and their quarantine until a load repair commits", async () => {
    const { storePath } = await makeStorePath();
    const malformed = makeJob("quarantine-retry-job");
    const surviving = makeJob("quarantine-survivor", {
      state: { nextRunAtMs: NOW + 60_000 },
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
    const state = makeState(storePath, onEvent);
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
      ...makeJob("  repro-stable-id  "),
      name: "handed",
      jobId: "ignored-obsolete-alias",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "tick", toolsAllow: [" read "] },
      runtimeAuthority,
    };

    await writeJobs(storePath, rawJob);
    await writeJobs(storePath, rawJob);

    const state = await loadState(storePath);

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
      makeJob("opaque-session-target-job", {
        name: "opaque session target job",
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget,
        payload: { kind: "agentTurn", message: "ping" },
      }),
    );

    const state = await loadState(storePath);

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
