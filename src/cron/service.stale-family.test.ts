import { constants, type DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { saveCronJobsStoreWithRevisionNative } from "./store.js";
import { deleteStaleCronJobFamilyRows, type CronJobFamilyIdentity } from "./store/row-codec.js";
import type { CronStoredJob } from "./types.js";

const family = {
  declarationKey: "memory-core:memory-dreaming-promotion",
  name: "Memory Dreaming Promotion",
  ownerPluginTag: "[managed-by=memory-core.short-term-promotion]",
};

function makeJob(id: string, fields: Partial<CronStoredJob> = {}): CronStoredJob {
  return {
    id,
    name: `Operator ${id}`,
    enabled: false,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "fixture" },
    state: {},
    ...fields,
  };
}

function readDurableRows(db: DatabaseSync) {
  return {
    jobs: db.prepare("SELECT * FROM cron_jobs ORDER BY store_key, job_id").all(),
    scratch: db.prepare("SELECT * FROM cron_job_scratch ORDER BY store_key, job_id").all(),
    authority: db
      .prepare("SELECT * FROM cron_job_runtime_authorities ORDER BY store_key, job_id")
      .all(),
  };
}

async function withFamilyStore(
  workload: { unrelatedCount: number; descriptionBytes: number },
  run: (fixture: {
    cron: CronService;
    db: DatabaseSync;
    activeStore: string;
    staleStore: string;
    removeFamilyNative: (
      family: CronJobFamilyIdentity,
      opts?: { beforeTransaction?: () => void },
    ) => Promise<number>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "cron-stale-family" }, async (state) => {
    const activeStore = state.statePath("cron", "jobs.json");
    const staleStore = state.statePath("obsolete", "cron", "jobs.json");
    const active = makeJob("active-owned", {
      declarationKey: family.declarationKey,
      name: family.name,
      description: `${family.ownerPluginTag} active`,
    });
    const stale = [
      makeJob("z-declared", {
        declarationKey: family.declarationKey,
        description: "Declared family with a renamed display name",
        runtimeAuthorityRecoveryRequired: true,
      }),
      makeJob("a-legacy", {
        name: family.name,
        description: `${family.ownerPluginTag} legacy`,
        runtimeAuthorityRecoveryRequired: true,
      }),
      makeJob("operator-same-name", {
        name: family.name,
        description: "Operator-owned job, not the managed family",
        runtimeAuthorityRecoveryRequired: true,
      }),
      ...Array.from({ length: workload.unrelatedCount }, (_, index) =>
        makeJob(`unrelated-${index}`, { description: "x".repeat(workload.descriptionBytes) }),
      ),
    ];
    saveCronJobsStoreWithRevisionNative(activeStore, { version: 1, jobs: [active] });
    saveCronJobsStoreWithRevisionNative(staleStore, { version: 1, jobs: stale });
    runOpenClawStateWriteTransaction(({ db }) => {
      const insert = db.prepare(
        "INSERT INTO cron_job_scratch (store_key, job_id, content, revision, updated_at_ms) VALUES (?, ?, ?, 1, 1800000000000)",
      );
      insert.run(activeStore, active.id, "active scratch");
      for (const job of stale) {
        insert.run(staleStore, job.id, `scratch:${job.id}`);
      }
    });
    const cron = new CronService({
      storePath: activeStore,
      cronEnabled: false,
      log: createNoopLogger(),
      nowMs: () => 1_800_000_000_000,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    try {
      expect((await cron.list({ includeDisabled: true })).map((job) => job.id)).toEqual([
        active.id,
      ]);
      await run({
        cron,
        db: openOpenClawStateDatabase().db,
        activeStore,
        staleStore,
        removeFamilyNative: async (identity, opts) => {
          opts?.beforeTransaction?.();
          return runOpenClawStateWriteTransaction(({ db }) =>
            deleteStaleCronJobFamilyRows(db, activeStore, identity),
          );
        },
      });
    } finally {
      cron.stop();
      await closeOpenClawStateDatabaseAsync();
    }
  });
}

function withoutJobs(before: ReturnType<typeof readDurableRows>, store: string, ids: string[]) {
  const keep = (row: Record<string, unknown>) =>
    row.store_key !== store || !ids.includes(String(row.job_id));
  return {
    jobs: before.jobs.filter(keep),
    scratch: before.scratch.filter(keep),
    authority: before.authority.filter(keep),
  };
}

const ordinary = { unrelatedCount: 3, descriptionBytes: 32 };

describe("Cron stale-family cleanup", () => {
  it.each([
    { label: "ordinary", ...ordinary },
    { label: "description-rich", unrelatedCount: 32, descriptionBytes: 128 * 1024 },
  ])(
    "preserves unrelated $label jobs in the row kernel without fetching their descriptions",
    async (workload) => {
      await withFamilyStore(workload, async ({ removeFamilyNative, db, staleStore }) => {
        const expected = withoutJobs(readDurableRows(db), staleStore, ["z-declared", "a-legacy"]);
        const counter = trackSqliteStatementExecutions(db, ["familyRows"], (sql) =>
          /^select\b/i.test(sql) && sql.includes('"cron_jobs"') ? "familyRows" : null,
        );
        const commitGuard = vi.fn();
        try {
          await expect(
            removeFamilyNative(family, { beforeTransaction: commitGuard }),
          ).resolves.toBe(2);
          expect(commitGuard).toHaveBeenCalledOnce();
        } finally {
          counter.restore();
        }
        expect(readDurableRows(db)).toEqual(expected);
        await closeOpenClawStateDatabaseAsync();
        expect(readDurableRows(openOpenClawStateDatabase().db)).toEqual(expected);
        await expect(removeFamilyNative(family)).resolves.toBe(0);
        expect(readDurableRows(openOpenClawStateDatabase().db)).toEqual(expected);
        expect(counter.counts.familyRows).toBeGreaterThan(0);
        expect(counter.rowCounts.familyRows).toBeGreaterThan(0);
        expect(counter.textBytes.familyRows).toBeLessThan(16 * 1024);
      });
    },
  );

  it("preserves decoded Unicode, malformed TEXT, and embedded NUL identities", async () => {
    await withFamilyStore(ordinary, async ({ cron, db, staleStore }) => {
      db.prepare("UPDATE cron_jobs SET name = CAST(x'80' AS TEXT) WHERE job_id = 'a-legacy'").run();
      db.prepare(
        "UPDATE cron_jobs SET declaration_key = CAST(x'80' AS TEXT) WHERE job_id = 'z-declared'",
      ).run();
      db.prepare("UPDATE cron_jobs SET name = ?, description = ? WHERE job_id = 'unrelated-0'").run(
        "ASCII\0tail",
        family.ownerPluginTag,
      );
      db.prepare(
        "UPDATE cron_jobs SET name = 'ASCII', description = CAST(x'80' AS TEXT) WHERE job_id = 'unrelated-1'",
      ).run();
      db.prepare(
        "UPDATE cron_jobs SET name = CAST(x'415343494980' AS TEXT) WHERE job_id = 'unrelated-2'",
      ).run();
      const before = readDurableRows(db);
      await expect(
        cron.removeStaleJobFamily({ ...family, declarationKey: "absent", name: "\ud800" }),
      ).resolves.toBe(0);
      expect(readDurableRows(db)).toEqual(before);
      await expect(
        cron.removeStaleJobFamily({ ...family, declarationKey: "absent", name: "\ufffd" }),
      ).resolves.toBe(1);
      await expect(
        cron.removeStaleJobFamily({ ...family, declarationKey: "\ufffd", name: "absent" }),
      ).resolves.toBe(1);
      await expect(
        cron.removeStaleJobFamily({ ...family, declarationKey: "absent", name: "ASCII\0tail" }),
      ).resolves.toBe(1);
      await expect(
        cron.removeStaleJobFamily({
          declarationKey: "absent",
          name: "ASCII",
          ownerPluginTag: "\ufffd",
        }),
      ).resolves.toBe(1);
      const expected = withoutJobs(before, staleStore, [
        "a-legacy",
        "z-declared",
        "unrelated-0",
        "unrelated-1",
      ]);
      expect(readDurableRows(db)).toEqual(expected);
      await closeOpenClawStateDatabaseAsync();
      expect(readDurableRows(openOpenClawStateDatabase().db)).toEqual(expected);
    });
  });

  it("preserves the first deletion error and scratch rollback with extra indexes", async () => {
    await withFamilyStore(ordinary, async ({ removeFamilyNative, db, activeStore }) => {
      const before = readDurableRows(db);
      for (const indexes of ["canonical", "separate", "covering"]) {
        if (indexes === "separate") {
          db.exec(`CREATE INDEX family_name ON cron_jobs(name);
            CREATE INDEX family_declaration ON cron_jobs(declaration_key);`);
        } else if (indexes === "covering") {
          db.exec(
            "CREATE INDEX family_covering ON cron_jobs(name, description, store_key, job_id, declaration_key)",
          );
        }
        db.exec("ANALYZE cron_jobs");
        for (const reversed of [false, true]) {
          db.exec(`PRAGMA reverse_unordered_selects = ${reversed ? "ON" : "OFF"}`);
          const originalRows = db
            .prepare(
              "SELECT store_key, job_id, declaration_key, name, description FROM cron_jobs WHERE store_key != ?",
            )
            .all(activeStore);
          const first = originalRows.find(
            (row) =>
              row.declaration_key === family.declarationKey ||
              (row.name === family.name &&
                typeof row.description === "string" &&
                row.description.includes(family.ownerPluginTag)),
          );
          expect(first).toBeDefined();
          try {
            await expect(
              removeFamilyNative(family, {
                beforeTransaction: () => {
                  db.exec(`CREATE TEMP TRIGGER refuse_family_delete BEFORE DELETE ON main.cron_jobs
              BEGIN SELECT RAISE(ABORT, 'refused:' || OLD.job_id); END;`);
                },
              }),
            ).rejects.toThrow(`refused:${String(first?.job_id)}`);
          } finally {
            db.exec("DROP TRIGGER IF EXISTS temp.refuse_family_delete");
          }
          expect(readDurableRows(db)).toEqual(before);
        }
      }
      db.exec("PRAGMA reverse_unordered_selects = OFF");
      await closeOpenClawStateDatabaseAsync();
      expect(readDurableRows(openOpenClawStateDatabase().db)).toEqual(before);
    });
  });

  it("retains column authorization and needs no SQL function authorization", async () => {
    await withFamilyStore(ordinary, async ({ removeFamilyNative, db, staleStore }) => {
      const before = readDurableRows(db);
      for (const column of ["store_key", "job_id", "declaration_key", "name", "description"]) {
        try {
          await expect(
            removeFamilyNative(family, {
              beforeTransaction: () => {
                db.setAuthorizer((action, table, readColumn) =>
                  action === constants.SQLITE_READ && table === "cron_jobs" && readColumn === column
                    ? constants.SQLITE_DENY
                    : constants.SQLITE_OK,
                );
              },
            }),
          ).rejects.toThrow(/prohibited|not authorized/i);
        } finally {
          db.setAuthorizer(null);
        }
        expect(readDurableRows(db)).toEqual(before);
      }
      try {
        await expect(
          removeFamilyNative(family, {
            beforeTransaction: () => {
              db.setAuthorizer((action, table, column) =>
                action === constants.SQLITE_READ &&
                table === "cron_jobs" &&
                column === "description"
                  ? constants.SQLITE_IGNORE
                  : constants.SQLITE_OK,
              );
            },
          }),
        ).resolves.toBe(1);
      } finally {
        db.setAuthorizer(null);
      }
      expect(readDurableRows(db)).toEqual(withoutJobs(before, staleStore, ["z-declared"]));
      try {
        await expect(
          removeFamilyNative(family, {
            beforeTransaction: () => {
              db.setAuthorizer((action) =>
                action === constants.SQLITE_FUNCTION ? constants.SQLITE_DENY : constants.SQLITE_OK,
              );
            },
          }),
        ).resolves.toBe(1);
      } finally {
        db.setAuthorizer(null);
      }
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
        await Promise.allSettled([
          blocker,
          ...(pruning ? [pruning] : []),
          ...(rejected ? [rejected] : []),
        ]);
      }
    });
  });
});
