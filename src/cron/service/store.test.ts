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

  it("quarantines malformed rows atomically while retaining valid legacy and repairable rows", async () => {
    const invalidTime = MAX_DATE_TIMESTAMP_MS + 1;
    const every = (everyMs: number, anchorMs?: number): CronJob["schedule"] => ({
      kind: "every",
      everyMs,
      ...(anchorMs === undefined ? {} : { anchorMs }),
    });
    const cases: Array<
      [
        id: string,
        reason: string | null,
        overrides: Partial<CronJob>,
        fields: Record<string, unknown>,
      ]
    > = [
      ["bad-kind", "invalid-schedule", {}, { "schedule.kind": "unsupported" }],
      ["legacy", null, {}, { schedule: "*/5 * * * *" }],
      ["legacy-trigger", null, {}, { schedule: "*/5 * * * *", trigger: { script: "true" } }],
      ["bad-trigger", "invalid-trigger", {}, { schedule: "*/5 * * * *", trigger: {} }],
      ["missing-payload", "missing-payload", {}, { schedule: "*/5 * * * *" }],
      [
        "bad-interval",
        "invalid-schedule",
        { schedule: every(1_000) },
        { "schedule.everyMs": invalidTime },
      ],
      [
        "bad-anchor",
        "invalid-schedule",
        { schedule: every(1_000, 0) },
        { "schedule.anchorMs": invalidTime },
      ],
      ["unsatisfiable", "unsatisfiable-schedule", { schedule: every(MAX_DATE_TIMESTAMP_MS) }, {}],
      ["disabled", null, { enabled: false, schedule: every(MAX_DATE_TIMESTAMP_MS) }, {}],
      ["bad-stagger", "invalid-schedule", {}, { "schedule.staggerMs": invalidTime }],
      ["repairable", null, { state: { lastRunAtMs: MAX_DATE_TIMESTAMP_MS } }, {}],
      ["bad-state", "invalid-state", {}, {}],
      ["survivor", null, { state: { nextRunAtMs: STORE_TEST_NOW + 60_000 } }, {}],
    ];
    await seed(...cases.map(([id, , overrides]) => createReloadCronJob({ id, ...overrides })));
    // JSON numeric injection preserves max + 1 exactly instead of rounding a SQLite FLOAT.
    for (const row of cases) {
      for (const [field, value] of Object.entries(row[3])) {
        corrupt(row[0], field, value);
      }
    }
    const db = openOpenClawStateDatabase().db;
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_remove(job_json, '$.payload') WHERE job_id = ?",
    ).run("missing-payload");
    db.prepare(
      "UPDATE cron_jobs SET state_json = json_set(state_json, '$.lastRunAtMs', json(?)) WHERE job_id = ?",
    ).run(JSON.stringify(invalidTime), "bad-state");
    await ensureLoaded(state);
    const survivors = cases.filter(([, reason]) => !reason).map(([id]) => id);
    expect(jobIds()).toEqual(survivors);
    expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(survivors);
    const quarantine = await quarantined();
    expect(quarantine).toEqual(
      cases.flatMap(([id, reason], sourceIndex) =>
        reason
          ? [expect.objectContaining({ sourceIndex, reason, job: expect.objectContaining({ id }) })]
          : [],
      ),
    );
    expect(quarantine.find((row) => row.job.id === "bad-state")?.state).toMatchObject({
      lastRunAtMs: invalidTime,
    });
    for (const row of cases) {
      const rejectedJob = quarantine.find((entry) => entry.job.id === row[0])?.job;
      for (const [field, value] of Object.entries(row[3])) {
        if (value === invalidTime) {
          expect(rejectedJob).toHaveProperty(field, invalidTime);
        }
      }
    }
    await expectPathMissing(storePath.replace(/\.json$/, "-quarantine.json"));
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

  it("normalizes persisted IDs, opaque session targets, tool caps and companion authority", async () => {
    const sessionTarget = "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";
    const rawJob = {
      ...createReloadCronJob({
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget,
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
    expect(job.sessionTarget).toBe(sessionTarget);
    expect((job as { jobId?: unknown }).jobId).toBeUndefined();
    expect(job.payload).toMatchObject({ kind: "agentTurn", toolsAllow: ["read"] });
    expect(job.runtimeAuthority).toEqual(rawJob.runtimeAuthority);
    await expectPathMissing(`${storePath}.migrated`);
  });
});
