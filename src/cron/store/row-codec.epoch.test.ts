import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import type { CronJob } from "../types.js";
import { deleteStaleCronJobFamilyRows } from "./job-family.js";
import {
  CronRuntimeRevisionMismatchError,
  CronStoreEpochMismatchError,
  loadedCronStoreFromRows,
  loadCronRows,
  materializeCronRowAgentOwners,
  readCronRuntimeRevision,
  readCronStoreEpoch,
  replaceCronRows,
  upsertCronJobRow,
  updateCronRuntimeRows,
} from "./row-codec.js";

const execFileAsync = promisify(execFile);

const concurrentWriterSource = `
  const { DatabaseSync } = await import("node:sqlite");
  const { upsertCronJobRow } = await import("./src/cron/store/row-codec.ts");
  const database = new DatabaseSync(process.argv[1]);
  database.exec("PRAGMA busy_timeout = 5000");
  const now = Date.now();
  const epoch = upsertCronJobRow(database, "cron-epoch-test", {
    id: process.argv[2],
    name: process.argv[2],
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
  }, 0);
  database.close();
  process.stdout.write(String(epoch));
`;

describe("cron store epoch", () => {
  it("bumps the epoch when a job_json-only config field is removed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-sidecar-"));
    const handle = openOpenClawStateDatabase({ path: path.join(root, "state.sqlite") });
    const database = handle.db;
    const storeKey = "job-json-topology";
    const job = makeCronJob({ id: "job-json" });
    const extendedJob = { ...job, additiveConfig: { mode: "future" } } as CronJob;
    try {
      expect(
        replaceCronRows(
          database,
          storeKey,
          { version: 1, jobs: [extendedJob] },
          {
            bumpStoreEpoch: true,
          },
        ),
      ).toBe(1);
      expect(
        replaceCronRows(
          database,
          storeKey,
          { version: 1, jobs: [job] },
          {
            bumpStoreEpoch: true,
          },
        ),
      ).toBe(2);
    } finally {
      handle.walMaintenance.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a stale full save after stale-family cleanup deletes its rows", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-family-epoch-"));
    const handle = openOpenClawStateDatabase({ path: path.join(root, "state.sqlite") });
    const database = handle.db;
    const activeStoreKey = "active-family-store";
    const staleStoreKey = "stale-family-store";
    const secondStaleStoreKey = "second-stale-family-store";
    const family = {
      declarationKey: "memory-core:promotion",
      name: "Memory Promotion",
      ownerPluginTag: "[managed-by=memory-core.promotion]",
    };
    const staleJob = {
      ...makeCronJob({ id: "stale-family-job" }),
      declarationKey: family.declarationKey,
      name: family.name,
      description: family.ownerPluginTag,
    };
    try {
      replaceCronRows(
        database,
        staleStoreKey,
        {
          version: 1,
          jobs: [staleJob, { ...staleJob, id: "second-stale-family-job" }],
        },
        { bumpStoreEpoch: true },
      );
      replaceCronRows(
        database,
        secondStaleStoreKey,
        { version: 1, jobs: [{ ...staleJob, id: "other-partition-family-job" }] },
        { bumpStoreEpoch: true },
      );
      const loaded = loadedCronStoreFromRows(
        loadCronRows(database, staleStoreKey),
        readCronStoreEpoch(database, staleStoreKey),
      );

      expect(deleteStaleCronJobFamilyRows(database, activeStoreKey, family)).toBe(3);
      expect(loadCronRows(database, staleStoreKey)).toEqual([]);
      expect(loadCronRows(database, secondStaleStoreKey)).toEqual([]);
      expect(readCronStoreEpoch(database, staleStoreKey)).toBe(loaded.storeEpoch + 1);
      expect(readCronStoreEpoch(database, secondStaleStoreKey)).toBe(2);
      expect(() =>
        replaceCronRows(database, staleStoreKey, loaded.store, {
          expectedStoreEpoch: loaded.storeEpoch,
          bumpStoreEpoch: true,
        }),
      ).toThrow(CronStoreEpochMismatchError);
      expect(loadCronRows(database, staleStoreKey)).toEqual([]);
    } finally {
      handle.walMaintenance.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves an explicit null owner through load and legacy-owner adoption", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-null-owner-"));
    const handle = openOpenClawStateDatabase({ path: path.join(root, "state.sqlite") });
    const database = handle.db;
    const storeKey = "null-owner";
    const job = makeCronJob({ id: "null-owner" });
    try {
      replaceCronRows(database, storeKey, { version: 1, jobs: [job] });
      const row = loadCronRows(database, storeKey)[0];
      if (!row) {
        throw new Error("missing cron row fixture");
      }
      const jobJson = JSON.parse(row.job_json) as Record<string, unknown>;
      jobJson.agentId = null;
      database
        .prepare("UPDATE cron_jobs SET agent_id = NULL, job_json = ? WHERE store_key = ?")
        .run(JSON.stringify(jobJson), storeKey);

      const loaded = loadedCronStoreFromRows(loadCronRows(database, storeKey)).store.jobs[0];
      expect(loaded && Object.hasOwn(loaded, "agentId")).toBe(true);
      expect((loaded as unknown as { agentId: unknown }).agentId).toBeNull();
      const beforeRejectedReplace = loadCronRows(database, storeKey)[0];
      expect(() =>
        replaceCronRows(database, storeKey, {
          version: 1,
          jobs: [loaded!],
        }),
      ).toThrow("Cannot persist cron store with 1 invalid job(s)");
      expect(loadCronRows(database, storeKey)[0]).toEqual(beforeRejectedReplace);
      expect(materializeCronRowAgentOwners(database, storeKey, "ops")).toBe(0);

      const unchangedRow = loadCronRows(database, storeKey)[0];
      expect(unchangedRow?.agent_id).toBeNull();
      expect(JSON.parse(unchangedRow?.job_json ?? "{}")).toHaveProperty("agentId", null);
    } finally {
      handle.walMaintenance.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves newer state-only runtime values across a stale full replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-runtime-revision-"));
    const handle = openOpenClawStateDatabase({ path: path.join(root, "state.sqlite") });
    const database = handle.db;
    const storeKey = "runtime-revision";
    const job = makeCronJob({ id: "runtime-revision-job" });
    const staleStore = { version: 1 as const, jobs: [structuredClone(job)] };
    const runtimeNextRunAtMs = job.updatedAtMs + 60_000;
    try {
      replaceCronRows(database, storeKey, staleStore, { bumpStoreEpoch: true });
      const epoch = readCronStoreEpoch(database, storeKey);
      const runtimeRevision = readCronRuntimeRevision(database, storeKey);
      const runtimeBaseline = new Map([[job.id, structuredClone(job.state)]]);
      const runtimeUpdatedAtBaseline = new Map([[job.id, job.updatedAtMs]]);
      updateCronRuntimeRows(database, storeKey, {
        version: 1,
        jobs: [
          {
            ...job,
            state: { nextRunAtMs: runtimeNextRunAtMs, lastStatus: "ok" },
          },
        ],
      });

      expect(() =>
        replaceCronRows(
          database,
          storeKey,
          { version: 1, jobs: [{ ...staleStore.jobs[0]!, name: "ambiguous rename" }] },
          {
            expectedStoreEpoch: epoch,
            expectedRuntimeRevision: runtimeRevision,
            bumpStoreEpoch: true,
          },
        ),
      ).toThrow(CronRuntimeRevisionMismatchError);

      expect(
        replaceCronRows(
          database,
          storeKey,
          {
            version: 1,
            jobs: [
              {
                ...staleStore.jobs[0]!,
                name: "renamed job",
                updatedAtMs: job.updatedAtMs + 30_000,
              },
            ],
          },
          {
            expectedStoreEpoch: epoch,
            expectedRuntimeRevision: runtimeRevision,
            expectedRuntimeStateByJobId: runtimeBaseline,
            expectedRuntimeUpdatedAtMsByJobId: runtimeUpdatedAtBaseline,
            bumpStoreEpoch: true,
          },
        ),
      ).toBe(epoch + 1);
      const renamed = loadedCronStoreFromRows(loadCronRows(database, storeKey), epoch + 1).store
        .jobs[0];
      expect(renamed?.name).toBe("renamed job");
      expect(renamed?.updatedAtMs).toBe(job.updatedAtMs + 30_000);
      expect(renamed?.state).toMatchObject({
        nextRunAtMs: runtimeNextRunAtMs,
        lastStatus: "ok",
      });

      const renamedRevision = readCronRuntimeRevision(database, storeKey);
      const renamedRuntimeBaseline = new Map([[renamed!.id, structuredClone(renamed!.state)]]);
      const renamedUpdatedAtBaseline = new Map([[renamed!.id, renamed!.updatedAtMs]]);
      const runningAtMs = runtimeNextRunAtMs + 1;
      updateCronRuntimeRows(database, storeKey, {
        version: 1,
        jobs: [{ ...renamed!, state: { ...renamed!.state, runningAtMs } }],
      });
      replaceCronRows(
        database,
        storeKey,
        {
          version: 1,
          jobs: [
            {
              ...renamed!,
              schedule: { kind: "every", everyMs: 120_000 },
              state: { ...renamed!.state, nextRunAtMs: undefined },
            },
          ],
        },
        {
          expectedStoreEpoch: epoch + 1,
          expectedRuntimeRevision: renamedRevision,
          expectedRuntimeStateByJobId: renamedRuntimeBaseline,
          expectedRuntimeUpdatedAtMsByJobId: renamedUpdatedAtBaseline,
          bumpStoreEpoch: true,
        },
      );
      expect(
        loadedCronStoreFromRows(loadCronRows(database, storeKey)).store.jobs[0]?.state,
      ).toMatchObject({ lastStatus: "ok", runningAtMs });
      expect(
        loadedCronStoreFromRows(loadCronRows(database, storeKey)).store.jobs[0]?.state.nextRunAtMs,
      ).toBeUndefined();
    } finally {
      handle.walMaintenance.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a timestamp-only runtime advance across a stale full replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-runtime-timestamp-"));
    const handle = openOpenClawStateDatabase({ path: path.join(root, "state.sqlite") });
    const database = handle.db;
    const storeKey = "runtime-timestamp";
    const job = makeCronJob({ id: "runtime-timestamp-job" });
    try {
      replaceCronRows(database, storeKey, { version: 1, jobs: [job] }, { bumpStoreEpoch: true });
      const epoch = readCronStoreEpoch(database, storeKey);
      const runtimeRevision = readCronRuntimeRevision(database, storeKey);
      const runtimeBaseline = new Map([[job.id, structuredClone(job.state)]]);
      const runtimeUpdatedAtBaseline = new Map([[job.id, job.updatedAtMs]]);
      const advancedUpdatedAtMs = job.updatedAtMs + 60_000;
      updateCronRuntimeRows(database, storeKey, {
        version: 1,
        jobs: [{ ...job, updatedAtMs: advancedUpdatedAtMs }],
      });

      replaceCronRows(
        database,
        storeKey,
        { version: 1, jobs: [{ ...job, name: "renamed after runtime update" }] },
        {
          expectedStoreEpoch: epoch,
          expectedRuntimeRevision: runtimeRevision,
          expectedRuntimeStateByJobId: runtimeBaseline,
          expectedRuntimeUpdatedAtMsByJobId: runtimeUpdatedAtBaseline,
          bumpStoreEpoch: true,
        },
      );

      const persisted = loadedCronStoreFromRows(loadCronRows(database, storeKey)).store.jobs[0];
      expect(persisted?.name).toBe("renamed after runtime update");
      expect(persisted?.updatedAtMs).toBe(advancedUpdatedAtMs);
    } finally {
      handle.walMaintenance.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a stale runtime writer after a row upsert replaces runtime state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-upsert-runtime-"));
    const handle = openOpenClawStateDatabase({ path: path.join(root, "state.sqlite") });
    const database = handle.db;
    const storeKey = "upsert-runtime-revision";
    const job = makeCronJob({ id: "upsert-runtime-job" });
    try {
      replaceCronRows(database, storeKey, { version: 1, jobs: [job] });
      const staleRuntimeRevision = readCronRuntimeRevision(database, storeKey);
      upsertCronJobRow(
        database,
        storeKey,
        { ...job, state: { nextRunAtMs: job.updatedAtMs + 60_000 } },
        0,
      );
      const currentRuntimeRevision = readCronRuntimeRevision(database, storeKey);

      expect(currentRuntimeRevision).toBe(staleRuntimeRevision + 1);
      expect(() =>
        updateCronRuntimeRows(
          database,
          storeKey,
          { version: 1, jobs: [{ ...job, state: {} }] },
          {
            expectedRuntimeRevision: staleRuntimeRevision,
            currentRuntimeRevision,
          },
        ),
      ).toThrow(CronRuntimeRevisionMismatchError);
      expect(
        loadedCronStoreFromRows(loadCronRows(database, storeKey)).store.jobs[0]?.state,
      ).toEqual({ nextRunAtMs: job.updatedAtMs + 60_000 });
    } finally {
      handle.walMaintenance.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back an early direct runtime write when a later job conflicts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-runtime-conflict-"));
    const handle = openOpenClawStateDatabase({ path: path.join(root, "state.sqlite") });
    const database = handle.db;
    const storeKey = "runtime-direct-conflict";
    const first = makeCronJob({ id: "runtime-first" });
    const second = makeCronJob({ id: "runtime-second" });
    try {
      replaceCronRows(database, storeKey, { version: 1, jobs: [first, second] });
      const expectedRuntimeRevision = readCronRuntimeRevision(database, storeKey);
      const expectedRuntimeStateByJobId = new Map(
        [first, second].map((job) => [job.id, structuredClone(job.state)]),
      );
      const expectedRuntimeUpdatedAtMsByJobId = new Map(
        [first, second].map((job) => [job.id, job.updatedAtMs]),
      );
      updateCronRuntimeRows(database, storeKey, {
        version: 1,
        jobs: [
          first,
          {
            ...second,
            updatedAtMs: second.updatedAtMs + 202,
            state: { nextRunAtMs: second.updatedAtMs + 202 },
          },
        ],
      });
      const currentRuntimeRevision = readCronRuntimeRevision(database, storeKey);
      const rowsBefore = loadCronRows(database, storeKey);

      expect(() =>
        updateCronRuntimeRows(
          database,
          storeKey,
          {
            version: 1,
            jobs: [
              {
                ...first,
                updatedAtMs: first.updatedAtMs + 101,
                state: { nextRunAtMs: first.updatedAtMs + 101 },
              },
              {
                ...second,
                updatedAtMs: second.updatedAtMs + 404,
                state: { nextRunAtMs: second.updatedAtMs + 404 },
              },
            ],
          },
          {
            expectedRuntimeRevision,
            currentRuntimeRevision,
            expectedRuntimeStateByJobId,
            expectedRuntimeUpdatedAtMsByJobId,
          },
        ),
      ).toThrow(CronRuntimeRevisionMismatchError);
      expect(loadCronRows(database, storeKey)).toEqual(rowsBefore);
      expect(readCronRuntimeRevision(database, storeKey)).toBe(currentRuntimeRevision);
    } finally {
      handle.walMaintenance.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back the row upsert when its runtime revision cannot advance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-upsert-atomic-"));
    const handle = openOpenClawStateDatabase({ path: path.join(root, "state.sqlite") });
    const database = handle.db;
    const storeKey = "upsert-atomic";
    const job = makeCronJob({ id: "upsert-atomic-job" });
    try {
      replaceCronRows(database, storeKey, { version: 1, jobs: [job] });
      const rowsBefore = loadCronRows(database, storeKey);
      const runtimeRevisionBefore = readCronRuntimeRevision(database, storeKey);
      database.exec(`
        CREATE TRIGGER fail_cron_runtime_revision
        BEFORE UPDATE OF store_epoch ON cron_store_epochs
        WHEN NEW.store_key = 'runtime-revision:${storeKey}'
        BEGIN
          SELECT RAISE(ABORT, 'synthetic runtime revision failure');
        END;
      `);

      expect(() =>
        upsertCronJobRow(
          database,
          storeKey,
          { ...job, state: { nextRunAtMs: job.updatedAtMs + 60_000 } },
          0,
        ),
      ).toThrow("synthetic runtime revision failure");
      expect(loadCronRows(database, storeKey)).toEqual(rowsBefore);
      expect(readCronRuntimeRevision(database, storeKey)).toBe(runtimeRevisionBefore);
    } finally {
      handle.walMaintenance.close();
      database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("assigns distinct epochs to concurrent row writes from independent processes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-epoch-"));
    const databasePath = path.join(root, "state.sqlite");
    openOpenClawStateDatabase({ path: databasePath });
    closeOpenClawStateDatabaseByPath(databasePath);
    const storeKey = "cron-epoch-test";
    try {
      const results = await Promise.all(
        ["first", "second"].map((jobId) =>
          execFileAsync(
            process.execPath,
            [
              "--import",
              "tsx",
              "--input-type=module",
              "-e",
              concurrentWriterSource,
              databasePath,
              jobId,
            ],
            { cwd: process.cwd() },
          ),
        ),
      );
      expect(results.map(({ stdout }) => Number(stdout)).toSorted((a, b) => a - b)).toEqual([1, 2]);

      const database = new DatabaseSync(databasePath);
      try {
        expect(readCronStoreEpoch(database, storeKey)).toBe(2);
      } finally {
        database.close();
      }
    } finally {
      closeOpenClawStateDatabaseByPath(databasePath);
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
