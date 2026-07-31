import { describe, expect, it } from "vitest";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { tryCronScheduleIdentity } from "./schedule-identity.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import {
  CronRuntimeRevisionMismatchError,
  CronStoreTopologyMismatchError,
  loadCronJobsStoreWithConfigJobs,
  loadCronStore,
  saveCronJobsStore,
  saveCronStore,
} from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { getCronStoreKysely } from "./store/schema.js";
import type { CronJob, CronStoreFile } from "./types.js";

const { makeStorePath } = setupCronServiceSuite({ prefix: "cron-runtime-delta" });
const NOW = Date.parse("2026-07-29T00:00:00.000Z");

function job(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: id },
    state: {},
  };
}

function runtimeBaseline(store: CronStoreFile) {
  return {
    states: new Map<string, CronJob["state"] | undefined>(
      store.jobs.map((entry) => [entry.id, structuredClone(entry.state ?? {})]),
    ),
    updatedAtMs: new Map(store.jobs.map((entry) => [entry.id, entry.updatedAtMs])),
  };
}

describe("cron state-only runtime deltas", () => {
  it("rejects a stale full save after a revision-blind topology edit", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, { version: 1, jobs: [job("runtime-a"), job("runtime-b")] });
    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const baseline = runtimeBaseline(loaded.store);
    const stale = structuredClone(loaded.store);
    stale.jobs[1]!.name = "caller edit";

    runOpenClawStateWriteTransaction(({ db }) => {
      const legacyEdit = { ...job("runtime-a"), name: "legacy edit", state: {} };
      executeSqliteQuerySync(
        db,
        getCronStoreKysely(db)
          .updateTable("cron_jobs")
          .set({ name: legacyEdit.name, job_json: JSON.stringify(legacyEdit) })
          .where("store_key", "=", cronStoreKey(storePath))
          .where("job_id", "=", legacyEdit.id),
      );
    });

    await expect(
      saveCronJobsStore(storePath, stale, {
        expectedStoreEpoch: loaded.storeEpoch,
        expectedTopologyFingerprintByJobId: loaded.topologyFingerprintByJobId,
        expectedRuntimeRevision: loaded.runtimeRevision,
        expectedRuntimeStateByJobId: baseline.states,
        expectedRuntimeUpdatedAtMsByJobId: baseline.updatedAtMs,
      }),
    ).rejects.toBeInstanceOf(CronStoreTopologyMismatchError);
    expect((await loadCronStore(storePath)).jobs.map((entry) => entry.name)).toEqual([
      "legacy edit",
      "runtime-b",
    ]);
  });

  it("rejects stale runtime state after a revision-blind schedule edit", async () => {
    const { storePath } = await makeStorePath();
    const original = job("runtime-a");
    await saveCronStore(storePath, { version: 1, jobs: [original] });
    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const baseline = runtimeBaseline(loaded.store);
    const stale = structuredClone(loaded.store);
    stale.jobs[0]!.state = { nextRunAtMs: NOW + 60_000 };
    const legacyEdit = { ...original, schedule: { kind: "every" as const, everyMs: 120_000 } };
    const legacyScheduleIdentity = tryCronScheduleIdentity(legacyEdit)!;

    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getCronStoreKysely(db)
          .updateTable("cron_jobs")
          .set({
            every_ms: 120_000,
            job_json: JSON.stringify({ ...legacyEdit, state: {} }),
            schedule_identity: legacyScheduleIdentity,
          })
          .where("store_key", "=", cronStoreKey(storePath))
          .where("job_id", "=", original.id),
      );
    });

    await expect(
      saveCronJobsStore(storePath, stale, {
        stateOnly: true,
        expectedStoreEpoch: loaded.storeEpoch,
        expectedRuntimeRevision: loaded.runtimeRevision,
        expectedRuntimeStateByJobId: baseline.states,
        expectedRuntimeUpdatedAtMsByJobId: baseline.updatedAtMs,
      }),
    ).rejects.toBeInstanceOf(CronRuntimeRevisionMismatchError);
    await expect(
      loadCronJobsStoreWithConfigJobs(storePath).then(
        (current) => current.configJobRuntimeEntries[0]?.scheduleIdentity,
      ),
    ).resolves.toBe(legacyScheduleIdentity);
  });

  it("preserves an out-of-band sibling update when the aggregate revision matches", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, { version: 1, jobs: [job("runtime-a"), job("runtime-b")] });
    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const baseline = runtimeBaseline(loaded.store);
    const writer = structuredClone(loaded.store);
    writer.jobs[1]!.state = { nextRunAtMs: 202 };
    writer.jobs[1]!.updatedAtMs = NOW + 202;

    // Simulate a revision-blind pre-upgrade writer changing only job A.
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getCronStoreKysely(db)
          .updateTable("cron_jobs")
          .set({
            next_run_at_ms: 101,
            state_json: JSON.stringify({ nextRunAtMs: 101 }),
            runtime_updated_at_ms: NOW + 101,
          })
          .where("store_key", "=", cronStoreKey(storePath))
          .where("job_id", "=", "runtime-a"),
      );
    });

    await saveCronJobsStore(storePath, writer, {
      stateOnly: true,
      expectedStoreEpoch: loaded.storeEpoch,
      expectedRuntimeRevision: loaded.runtimeRevision,
      expectedRuntimeStateByJobId: baseline.states,
      expectedRuntimeUpdatedAtMsByJobId: baseline.updatedAtMs,
    });

    const persisted = await loadCronStore(storePath);
    expect(persisted.jobs.map((entry) => entry.state.nextRunAtMs)).toEqual([101, 202]);
    expect(persisted.jobs.map((entry) => entry.updatedAtMs)).toEqual([NOW + 101, NOW + 202]);
  });

  it("merges different-job writes and rejects a same-job conflict", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, { version: 1, jobs: [job("runtime-a"), job("runtime-b")] });
    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const baseline = runtimeBaseline(loaded.store);
    const writerA = structuredClone(loaded.store);
    const writerB = structuredClone(loaded.store);
    writerA.jobs[0]!.state = { nextRunAtMs: 101 };
    writerA.jobs[0]!.updatedAtMs = NOW + 101;
    writerB.jobs[1]!.state = { nextRunAtMs: 202 };

    let writerBResult: Awaited<ReturnType<typeof saveCronJobsStore>> = undefined;
    for (const writer of [writerA, writerB]) {
      const result = await saveCronJobsStore(storePath, writer, {
        stateOnly: true,
        expectedStoreEpoch: loaded.storeEpoch,
        expectedRuntimeRevision: loaded.runtimeRevision,
        expectedRuntimeStateByJobId: baseline.states,
        expectedRuntimeUpdatedAtMsByJobId: baseline.updatedAtMs,
      });
      if (writer === writerB) {
        writerBResult = result;
      }
    }
    expect(writerB.jobs[0]?.state.nextRunAtMs).toBeUndefined();
    expect(writerBResult?.store.jobs[0]?.state.nextRunAtMs).toBe(101);
    expect(writerBResult?.store.jobs[0]?.updatedAtMs).toBe(NOW + 101);
    expect((await loadCronStore(storePath)).jobs.map((entry) => entry.state.nextRunAtMs)).toEqual([
      101, 202,
    ]);

    const conflictBase = await loadCronJobsStoreWithConfigJobs(storePath);
    const conflictBaseline = runtimeBaseline(conflictBase.store);
    const first = structuredClone(conflictBase.store);
    const stale = structuredClone(conflictBase.store);
    first.jobs[0]!.state = { nextRunAtMs: 303 };
    stale.jobs[0]!.state = { nextRunAtMs: 404 };
    await saveCronJobsStore(storePath, first, {
      stateOnly: true,
      expectedStoreEpoch: conflictBase.storeEpoch,
      expectedRuntimeRevision: conflictBase.runtimeRevision,
      expectedRuntimeStateByJobId: conflictBaseline.states,
      expectedRuntimeUpdatedAtMsByJobId: conflictBaseline.updatedAtMs,
    });
    await expect(
      saveCronJobsStore(storePath, stale, {
        stateOnly: true,
        expectedStoreEpoch: conflictBase.storeEpoch,
        expectedRuntimeRevision: conflictBase.runtimeRevision,
        expectedRuntimeStateByJobId: conflictBaseline.states,
        expectedRuntimeUpdatedAtMsByJobId: conflictBaseline.updatedAtMs,
      }),
    ).rejects.toBeInstanceOf(CronRuntimeRevisionMismatchError);
  });

  it("accepts an explicitly undefined baseline for matching empty state", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, { version: 1, jobs: [job("runtime-a"), job("runtime-b")] });
    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const baseline = runtimeBaseline(loaded.store);
    baseline.states.set("runtime-a", undefined);
    const concurrent = structuredClone(loaded.store);
    const stale = structuredClone(loaded.store);
    concurrent.jobs[1]!.state = { nextRunAtMs: 202 };

    await saveCronJobsStore(storePath, concurrent, {
      stateOnly: true,
      expectedStoreEpoch: loaded.storeEpoch,
      expectedRuntimeRevision: loaded.runtimeRevision,
      expectedRuntimeStateByJobId: baseline.states,
      expectedRuntimeUpdatedAtMsByJobId: baseline.updatedAtMs,
    });
    await expect(
      saveCronJobsStore(storePath, stale, {
        stateOnly: true,
        expectedStoreEpoch: loaded.storeEpoch,
        expectedRuntimeRevision: loaded.runtimeRevision,
        expectedRuntimeStateByJobId: baseline.states,
        expectedRuntimeUpdatedAtMsByJobId: baseline.updatedAtMs,
      }),
    ).resolves.toBeDefined();
  });

  it("leaves the in-memory store untouched when a later job conflicts", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, { version: 1, jobs: [job("runtime-a"), job("runtime-b")] });
    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const baseline = runtimeBaseline(loaded.store);
    const concurrent = structuredClone(loaded.store);
    const stale = structuredClone(loaded.store);
    concurrent.jobs[0]!.state = { nextRunAtMs: 101 };
    concurrent.jobs[1]!.state = { nextRunAtMs: 202 };
    stale.jobs[1]!.state = { nextRunAtMs: 404 };

    await saveCronJobsStore(storePath, concurrent, {
      stateOnly: true,
      expectedStoreEpoch: loaded.storeEpoch,
      expectedRuntimeRevision: loaded.runtimeRevision,
      expectedRuntimeStateByJobId: baseline.states,
      expectedRuntimeUpdatedAtMsByJobId: baseline.updatedAtMs,
    });
    const staleBeforeSave = structuredClone(stale);
    await expect(
      saveCronJobsStore(storePath, stale, {
        stateOnly: true,
        expectedStoreEpoch: loaded.storeEpoch,
        expectedRuntimeRevision: loaded.runtimeRevision,
        expectedRuntimeStateByJobId: baseline.states,
        expectedRuntimeUpdatedAtMsByJobId: baseline.updatedAtMs,
      }),
    ).rejects.toBeInstanceOf(CronRuntimeRevisionMismatchError);

    expect(stale).toEqual(staleBeforeSave);
    expect((await loadCronStore(storePath)).jobs.map((entry) => entry.state.nextRunAtMs)).toEqual([
      101, 202,
    ]);
  });

  it("preserves a concurrent timestamp-only advance on an unchanged sibling", async () => {
    const { storePath } = await makeStorePath();
    await saveCronStore(storePath, { version: 1, jobs: [job("runtime-a"), job("runtime-b")] });
    const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
    const baseline = runtimeBaseline(loaded.store);
    const timestampWriter = structuredClone(loaded.store);
    const siblingWriter = structuredClone(loaded.store);
    timestampWriter.jobs[0]!.updatedAtMs = NOW + 101;
    siblingWriter.jobs[1]!.state = { nextRunAtMs: 202 };
    siblingWriter.jobs[1]!.updatedAtMs = NOW + 202;

    await saveCronJobsStore(storePath, timestampWriter, {
      stateOnly: true,
      expectedStoreEpoch: loaded.storeEpoch,
      expectedRuntimeRevision: loaded.runtimeRevision,
      expectedRuntimeStateByJobId: baseline.states,
      expectedRuntimeUpdatedAtMsByJobId: baseline.updatedAtMs,
    });
    const siblingResult = await saveCronJobsStore(storePath, siblingWriter, {
      stateOnly: true,
      expectedStoreEpoch: loaded.storeEpoch,
      expectedRuntimeRevision: loaded.runtimeRevision,
      expectedRuntimeStateByJobId: baseline.states,
      expectedRuntimeUpdatedAtMsByJobId: baseline.updatedAtMs,
    });

    expect(siblingWriter.jobs[0]?.updatedAtMs).toBe(NOW);
    expect(siblingResult?.store.jobs[0]?.updatedAtMs).toBe(NOW + 101);
    expect((await loadCronStore(storePath)).jobs.map((entry) => entry.updatedAtMs)).toEqual([
      NOW + 101,
      NOW + 202,
    ]);
  });
});
