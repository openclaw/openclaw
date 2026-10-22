import { constants, type DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { seedCronStoreInCurrentDatabase } from "../../test/helpers/cron/store.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cronTestDeps, cronTestJob } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import { deleteStaleCronJobFamilyRows, type CronJobFamilyIdentity } from "./store/row-codec.js";
import type { CronStoredJob } from "./types.js";

const family = {
  declarationKey: "memory-core:memory-dreaming-promotion",
  name: "Memory Dreaming Promotion",
  ownerPluginTag: "[managed-by=memory-core.short-term-promotion]",
};

function makeJob(id: string, fields: Partial<CronStoredJob> = {}): CronStoredJob {
  return cronTestJob({
    id,
    name: `Operator ${id}`,
    enabled: false,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "fixture" },
    ...fields,
  });
}

const durableTables = ["cron_jobs", "cron_job_scratch", "cron_job_runtime_authorities"];
const readDurableRows = (db: EngineConnection = openOpenClawStateDatabase().db) =>
  durableTables.map((table) =>
    db.prepare(`SELECT * FROM ${table} ORDER BY store_key, job_id`).all(),
  );

async function expectPersisted(expected: ReturnType<typeof readDurableRows>) {
  expect(readDurableRows()).toEqual(expected);
  await closeOpenClawStateDatabaseAsync();
  expect(readDurableRows()).toEqual(expected);
}

async function withFamilyStore(
  workload: { unrelatedCount: number; descriptionBytes: number },
  run: (fixture: {
    cron: CronService;
    db: DatabaseSync;
    staleStore: string;
    removeFamilyNative: (family: CronJobFamilyIdentity) => Promise<number>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "cron-stale-family" }, async (state) => {
    const activeStore = state.statePath("cron", "jobs.json");
    const staleStore = state.statePath("obsolete", "cron", "jobs.json");
    const ownedFields = { name: family.name, description: family.ownerPluginTag };
    const active = makeJob("active-owned", {
      ...ownedFields,
      declarationKey: family.declarationKey,
    });
    const stale = [
      ...[
        { id: "z-declared", declarationKey: family.declarationKey, description: "Renamed" },
        { id: "a-legacy", ...ownedFields },
        { id: "operator-same-name", name: family.name, description: "Operator-owned" },
      ].map(({ id, ...fields }) =>
        makeJob(id, { ...fields, runtimeAuthorityRecoveryRequired: true }),
      ),
      ...Array.from({ length: workload.unrelatedCount }, (_, index) =>
        makeJob(`unrelated-${index}`, { description: "x".repeat(workload.descriptionBytes) }),
      ),
    ];
    seedCronStoreInCurrentDatabase(activeStore, { version: 1, jobs: [active] });
    seedCronStoreInCurrentDatabase(staleStore, { version: 1, jobs: stale });
    runOpenClawStateWriteTransaction(({ db }) => {
      const insert = db.prepare(
        "INSERT INTO cron_job_scratch (store_key, job_id, content, revision, updated_at_ms) VALUES (?, ?, ?, 1, 1800000000000)",
      );
      insert.run(activeStore, active.id, "active scratch");
      for (const job of stale) {
        insert.run(staleStore, job.id, `scratch:${job.id}`);
      }
    });
    const cron = new CronService(
      cronTestDeps({
        storePath: activeStore,
        cronEnabled: false,
        nowMs: () => 1_800_000_000_000,
      }),
    );
    try {
      expect((await cron.list({ includeDisabled: true })).map((job) => job.id)).toEqual([
        active.id,
      ]);
      await run({
        cron,
        db: requireNativeSqliteDatabase(openOpenClawStateDatabase().db),
        staleStore,
        removeFamilyNative: async (identity) =>
          runOpenClawStateWriteTransaction(({ db }) =>
            deleteStaleCronJobFamilyRows(db, activeStore, identity),
          ),
      });
    } finally {
      cron.stop();
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

function withoutJobs(before: ReturnType<typeof readDurableRows>, store: string, ids: string[]) {
  return before.map((rows) =>
    rows.filter((row) => row.store_key !== store || !ids.includes(String(row.job_id))),
  );
}

const ordinary = { unrelatedCount: 3, descriptionBytes: 32 };

describe("Cron stale-family cleanup", () => {
  it("preserves unrelated description-rich jobs without fetching their descriptions", async () => {
    await withFamilyStore(
      { unrelatedCount: 32, descriptionBytes: 128 * 1024 },
      async ({ removeFamilyNative, db, staleStore }) => {
        const expected = withoutJobs(readDurableRows(db), staleStore, ["z-declared", "a-legacy"]);
        const counter = trackSqliteStatementExecutions(db, ["familyRows"], (sql) =>
          /^select\b/i.test(sql) && sql.includes('"cron_jobs"') ? "familyRows" : null,
        );
        try {
          await expect(removeFamilyNative(family)).resolves.toBe(2);
        } finally {
          counter.restore();
        }
        await expectPersisted(expected);
        await expect(removeFamilyNative(family)).resolves.toBe(0);
        expect(readDurableRows()).toEqual(expected);
        expect(counter.counts.familyRows).toBeGreaterThan(0);
        expect(counter.rowCounts.familyRows).toBeGreaterThan(0);
        expect(counter.textBytes.familyRows).toBeLessThan(16 * 1024);
      },
    );
  });

  it("preserves decoded Unicode, malformed TEXT, and embedded NUL identities", async () => {
    await withFamilyStore(ordinary, async ({ cron, db, staleStore }) => {
      db.exec(`
        UPDATE cron_jobs SET name = CAST(x'80' AS TEXT) WHERE job_id = 'a-legacy';
        UPDATE cron_jobs SET declaration_key = CAST(x'80' AS TEXT) WHERE job_id = 'z-declared';
        UPDATE cron_jobs SET name = 'ASCII', description = CAST(x'80' AS TEXT) WHERE job_id = 'unrelated-1';
        UPDATE cron_jobs SET name = CAST(x'415343494980' AS TEXT) WHERE job_id = 'unrelated-2';
      `);
      db.prepare("UPDATE cron_jobs SET name = ?, description = ? WHERE job_id = 'unrelated-0'").run(
        "ASCII\0tail",
        family.ownerPluginTag,
      );
      const before = readDurableRows(db);
      const remove = (
        name: string,
        declarationKey = "absent",
        ownerPluginTag = family.ownerPluginTag,
      ) => cron.removeStaleJobFamily({ name, declarationKey, ownerPluginTag });
      await expect(remove("\ud800")).resolves.toBe(0);
      expect(readDurableRows(db)).toEqual(before);
      await expect(remove("\ufffd")).resolves.toBe(1);
      await expect(remove("absent", "\ufffd")).resolves.toBe(1);
      await expect(remove("ASCII\0tail")).resolves.toBe(1);
      await expect(remove("ASCII", "absent", "\ufffd")).resolves.toBe(1);
      const expected = withoutJobs(before, staleStore, [
        "a-legacy",
        "z-declared",
        "unrelated-0",
        "unrelated-1",
      ]);
      await expectPersisted(expected);
    });
  });

  it("retains column authorization and needs no SQL function authorization", async () => {
    await withFamilyStore(ordinary, async ({ removeFamilyNative, db, staleStore }) => {
      const before = readDurableRows(db);
      const restrictedRemove = async (column?: string, policy = constants.SQLITE_DENY) => {
        db.setAuthorizer((action, table, readColumn) =>
          (
            column
              ? action === constants.SQLITE_READ && table === "cron_jobs" && readColumn === column
              : action === constants.SQLITE_FUNCTION
          )
            ? policy
            : constants.SQLITE_OK,
        );
        try {
          return await removeFamilyNative(family);
        } finally {
          db.setAuthorizer(null);
        }
      };
      for (const column of ["store_key", "job_id", "declaration_key", "name", "description"]) {
        await expect(restrictedRemove(column)).rejects.toThrow(/prohibited|not authorized/i);
        expect(readDurableRows(db)).toEqual(before);
      }
      await expect(restrictedRemove("description", constants.SQLITE_IGNORE)).resolves.toBe(1);
      expect(readDurableRows(db)).toEqual(withoutJobs(before, staleStore, ["z-declared"]));
      await expect(restrictedRemove(undefined)).resolves.toBe(1);
      expect(readDurableRows(db)).toEqual(
        withoutJobs(before, staleStore, ["z-declared", "a-legacy"]),
      );
    });
  });

  it("rechecks live authority after waiting for the service lock", async () => {
    await withFamilyStore(ordinary, async ({ cron, db }) => {
      const entered = createDeferred();
      const release = createDeferred();
      const blocker = cron.updateWithPrecondition("active-owned", {}, async () => {
        entered.resolve();
        await release.promise;
      });
      let pruning: Promise<number> | undefined;
      let rejected: Promise<void> | undefined;
      try {
        await Promise.race([entered.promise, blocker]);
        let active = true;
        const guard = vi.fn(() => {
          if (!active) {
            throw new Error("family owner retired");
          }
        });
        pruning = cron.removeStaleJobFamily(family, { commitGuard: guard });
        rejected = expect(pruning).rejects.toThrow("family owner retired");
        expect(guard).not.toHaveBeenCalled();
        active = false;
        release.resolve();
        await blocker;
        const before = readDurableRows(db);
        await rejected;
        expect(guard).toHaveBeenCalledOnce();
        expect(readDurableRows(db)).toEqual(before);
      } finally {
        release.resolve();
        await Promise.allSettled([blocker, pruning, rejected]);
      }
    });
  });
});
