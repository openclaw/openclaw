import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  assertMigrationBulkSafe,
  classifyMigrationBulkAccess,
} from "../../scripts/e2e/lib/upgrade-survivor/sqlite-bulk-access.mts";
import type { SqliteMigrationObservation } from "../../scripts/e2e/lib/upgrade-survivor/sqlite-migration-observation.mts";
import { installSqliteMigrationObserver } from "../../scripts/e2e/lib/upgrade-survivor/sqlite-migration-observer.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

// Loading-boundary test: static owner imports would capture native APIs before instrumentation.
const observer = installSqliteMigrationObserver();
await observer.qualifyNativeBindings().catch((error: unknown) => {
  writeMigrationFailure(error, { stage: "native-bindings" });
  observer.dispose();
  throw error;
});
const { DatabaseSync } = await import("node:sqlite");
const integrity = await import("../../src/infra/sqlite-integrity.js");
const worker = await import("../../src/infra/sqlite-integrity-worker.js");
const helpers = await import("../../src/state/openclaw-agent-db-schema-helpers.js");
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { OPENCLAW_AGENT_SCHEMA_VERSION: target } =
  await import("../../src/state/openclaw-agent-db-contract.js");
const { withAgentDatabaseMaintenanceLease } =
  await import("../../src/state/openclaw-agent-db-maintenance-lease.js");
const { migrateOpenClawAgentDatabaseForMaintenance } =
  await import("../../src/state/openclaw-agent-db-maintenance.js");
const { resolveOpenClawAgentSqlitePath } = await import("../../src/state/openclaw-agent-db.js");
const { getOpenClawAgentMigrationSchema } =
  await import("../../src/state/openclaw-agent-schema-history.js");
const { seedVersion } = await import("../../src/state/schema-migration.test-support.js");
const { normalizeSqliteText } = await import("../../src/state/openclaw-state-db-schema-repair.js");
const { createOpenClawDatabaseMaintenanceScope, runOutsideOpenClawDatabaseMaintenanceScope } =
  await import("../../src/state/openclaw-state-db-async-lifecycle.js");
const original = {
  ...integrity,
  ...worker,
  finishAgentSchemaMigration: helpers.finishAgentSchemaMigration,
  ensureSessionReactionsSchemaInTransaction: helpers.ensureSessionReactionsSchemaInTransaction,
};
const configuredBaseline = Number(
  process.env.OPENCLAW_UPGRADE_SURVIVOR_BULK_BASELINE ?? target - 1,
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type FixtureStep = "step" | "callback" | "unsupported" | "same-version";
let fixtureBulkStep: FixtureStep | undefined;
let sameVersionRepairObserved = false;
const forbiddenSql = "UPDATE transcript_events SET event_json=event_json WHERE 0";

function readBaselineSchema(version: number): string {
  const filename = process.env.OPENCLAW_UPGRADE_SURVIVOR_BULK_BASELINE_SCHEMA;
  if (filename) {
    return fs.readFileSync(filename, "utf8");
  }
  if (process.env.OPENCLAW_UPGRADE_SURVIVOR_BULK_BASELINE) {
    throw new Error("Selected migration qualification requires frozen fork-point DDL");
  }
  return getOpenClawAgentMigrationSchema(version);
}

function writeMigrationReceipt(facts: Record<string, unknown>) {
  const filename = process.env.OPENCLAW_UPGRADE_SURVIVOR_BULK_RECEIPT;
  if (filename) {
    fs.writeFileSync(
      filename,
      JSON.stringify(
        {
          previousSource: process.env.OPENCLAW_SCHEMA_DOWNGRADE_BASE_SHA,
          candidateSource: process.env.GIT_COMMIT,
          ...facts,
        },
        null,
        2,
      ),
    );
  }
}
function writeMigrationFailure(error: unknown, facts: Record<string, unknown>) {
  const observation = observer.readFailureObservation(error);
  try {
    writeMigrationReceipt({
      ...facts,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      observation: observation
        ? {
            integrityChecks: observation.integrityChecks,
            coverageFailures: observation.coverageFailures,
            statements: observation.statements.map(
              ({ databaseId, method, sql, ownerIntegrity }) => ({
                databaseId,
                method,
                sql,
                ownerIntegrity,
              }),
            ),
          }
        : null,
    });
  } catch (receiptError) {
    console.error("Could not retain migration failure receipt:", receiptError);
  }
}
beforeEach(() => {
  for (const name of [
    "assertSqliteIntegrity",
    "assertSqliteTableIntegrity",
    "readSqliteIntegrityFindings",
  ] as const) {
    vi.spyOn(integrity, name).mockImplementation(
      (...args: Parameters<(typeof integrity)[typeof name]>) =>
        observer.withOwnerIntegrity(name, () => Reflect.apply(original[name], undefined, args)),
    );
  }
  vi.spyOn(worker, "assertSqliteIntegrityInWorker").mockImplementation((...args) =>
    observer.withOwnerIntegrity("assertSqliteIntegrityInWorker", () =>
      original.assertSqliteIntegrityInWorker(...args),
    ),
  );
  vi.spyOn(worker, "runSqliteIntegrityCheckInWorkerSync").mockImplementation((...args) =>
    observer.withOwnerIntegrity("runSqliteIntegrityCheckInWorkerSync", () =>
      original.runSqliteIntegrityCheckInWorkerSync(...args),
    ),
  );
  vi.spyOn(helpers, "ensureSessionReactionsSchemaInTransaction").mockImplementation((db) => {
    const pending = !db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='session_reactions'")
      .get();
    original.ensureSessionReactionsSchemaInTransaction(db);
    if (fixtureBulkStep === "same-version" && pending) {
      sameVersionRepairObserved = true;
      db.exec(forbiddenSql);
    }
  });
  vi.spyOn(helpers, "finishAgentSchemaMigration").mockImplementation((...args) => {
    if (fixtureBulkStep === "step") {
      args[0].exec(forbiddenSql);
    }
    if (fixtureBulkStep === "unsupported") {
      try {
        args[0].createTagStore();
      } catch {
        // Deliberately caught: observation must still fail and retain its evidence.
      }
    }
    const assertMigration = args[6];
    args[6] = () =>
      observer.withMigrationWork(() => {
        if (fixtureBulkStep === "callback") {
          args[0].exec(forbiddenSql);
        }
        return assertMigration();
      });
    return observer.withOwnerIntegrity("finishAgentSchemaMigration", () =>
      original.finishAgentSchemaMigration(...args),
    );
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => observer.dispose());

async function migrate(bulk: FixtureStep | undefined, baseline: number, schemaSql: string) {
  fixtureBulkStep = bulk;
  sameVersionRepairObserved = false;
  expect(Number.isInteger(baseline) && baseline > 0 && baseline <= target).toBe(true);
  return withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const pathname = resolveOpenClawAgentSqlitePath(options);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    {
      using db = new DatabaseSync(pathname);
      db.exec(schemaSql);
      seedVersion(db, baseline);
      db.exec(`INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at)
          VALUES ('agent:main:test','test','{"sessionId":"test","updatedAt":1,"visibility":"shared","delivery":{"kind":"none"}}',1,1);
        INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES ('test','agent:main:test',1,1);
        INSERT INTO transcript_events(session_id,seq,event_json,created_at)
          VALUES ('test',1,'{"type":"message","message":{"role":"user","content":"retained"}}',1);
        ANALYZE;`);
    }
    // Lease admission is outside SQL observation; the real migration retains that lease throughout.
    let observation: SqliteMigrationObservation;
    try {
      ({ observation } = await withAgentDatabaseMaintenanceLease(options, async (maintenance) => {
        const scope = createOpenClawDatabaseMaintenanceScope({
          schemaMaintenance: true,
          // The lease's own storage retains its independent custody, like Doctor's root lock.
          assertOwnerCurrent: () =>
            runOutsideOpenClawDatabaseMaintenanceScope(() => maintenance.assertOwned()),
        });
        try {
          return await scope.run(() =>
            observer.observe(() =>
              migrateOpenClawAgentDatabaseForMaintenance({ ...options, pathname }, maintenance),
            ),
          );
        } finally {
          await scope.close();
        }
      }));
    } catch (error) {
      writeMigrationFailure(error, {
        stage: "migration",
        store: "agent/main",
        fromVersion: baseline,
        toVersion: target,
        beforeMinReader: baseline,
        afterMinReader: null,
      });
      throw error;
    }
    using db = new DatabaseSync(pathname);
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: target });
    expect(db.prepare("SELECT COUNT(*) AS count FROM transcript_events").get()).toEqual({
      count: 1,
    });
    const floor = db
      .prepare("PRAGMA table_info(schema_meta)")
      .all()
      .some((column) => column.name === "min_reader")
      ? Number(
          db
            .prepare(
              "SELECT COALESCE(min_reader,schema_version) AS floor FROM schema_meta WHERE meta_key='primary'",
            )
            .get()?.floor,
        )
      : target;
    const range = {
      store: "agent/main",
      fromVersion: baseline,
      toVersion: target,
      beforeMinReader: baseline,
      afterMinReader: floor,
    };
    const receipt = classifyMigrationBulkAccess(observation, range);
    expect(receipt.integrityChecks).not.toEqual([]);
    return { observation, range, receipt };
  });
}
it("enforces bulk-data access on the real main migration chain with its integrity checks", async () => {
  const { observation, range, receipt } = await migrate(
    process.env.OPENCLAW_UPGRADE_SURVIVOR_BULK_FIXTURE_STEP === "1" ? "step" : undefined,
    configuredBaseline,
    readBaselineSchema(configuredBaseline),
  );
  writeMigrationReceipt({ ...range, ...receipt });
  assertMigrationBulkSafe(observation, range);
});

it.each([false, true])(
  "normalizes historical typed BLOB keys and references atomically (conflict: %s)",
  (conflict) => {
    using db = new DatabaseSync(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE child (parent_id TEXT REFERENCES parent(id));
      CREATE TABLE parent (id TEXT PRIMARY KEY, bytes BLOB);
      INSERT INTO parent VALUES (CAST('retained' AS BLOB), X'00FF');
      INSERT INTO child VALUES (CAST('retained' AS BLOB));
      CREATE TABLE strict_payload (value ANY) STRICT;
      INSERT INTO strict_payload VALUES (X'00FF');
    `);
    if (conflict) {
      db.exec("INSERT INTO parent VALUES ('retained', X'01')");
      expect(() => normalizeSqliteText(db)).toThrow(/UNIQUE constraint failed: parent.id/u);
    } else {
      normalizeSqliteText(db);
    }
    expect(
      db.prepare("SELECT typeof(id) AS storage, hex(bytes) AS bytes FROM parent LIMIT 1").get(),
    ).toEqual({ storage: conflict ? "blob" : "text", bytes: "00FF" });
    expect(db.prepare("SELECT typeof(parent_id) AS storage FROM child").get()).toEqual({
      storage: conflict ? "blob" : "text",
    });
    expect(
      db.prepare("SELECT typeof(value) AS storage, hex(value) AS bytes FROM strict_payload").get(),
    ).toEqual({ storage: "blob", bytes: "00FF" });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.isTransaction).toBe(false);
  },
);
it.each(["step", "callback"] as const)(
  "rejects a real WHERE 0 fixture %s around the finalizer",
  async (location) => {
    const { observation, range, receipt } = await migrate(
      location,
      target - 1,
      getOpenClawAgentMigrationSchema(target - 1),
    );
    expect(receipt.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "transcript_events", store: "agent/main" }),
      ]),
    );
    expect(() => assertMigrationBulkSafe(observation, range)).toThrow(/agent\/main.*bulk-data/u);
  },
);

it("retains sanitized coverage evidence and rethrows the original observation failure", async () => {
  const filename = path.join(tempDirs.make("bulk-coverage-"), "receipt.json");
  vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_BULK_RECEIPT", filename);
  const failure = await migrate(
    "unsupported",
    target - 1,
    getOpenClawAgentMigrationSchema(target - 1),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  const coverageFailures = ["Unsupported SQLite observation API: createTagStore"];
  expect(failure).toBeInstanceOf(Error);
  expect(observer.readFailureObservation(failure)?.coverageFailures).toEqual(coverageFailures);
  const receipt = JSON.parse(fs.readFileSync(filename, "utf8"));
  expect(receipt).toMatchObject({
    status: "failed",
    stage: "migration",
    store: "agent/main",
    fromVersion: target - 1,
    toVersion: target,
    afterMinReader: null,
    observation: {
      coverageFailures,
      integrityChecks: expect.arrayContaining(["finishAgentSchemaMigration"]),
    },
  });
  expect(receipt.observation.statements.length).toBeGreaterThan(0);
  for (const statement of receipt.observation.statements) {
    expect(statement).not.toHaveProperty("databasePath");
  }
});

it("rejects bulk work in a same-version additive repair from frozen baseline DDL", async () => {
  const filename = path.join(tempDirs.make("same-version-baseline-"), "schema.sql");
  {
    using previous = new DatabaseSync(":memory:");
    previous.exec(getOpenClawAgentMigrationSchema(target));
    previous.exec("DROP TABLE session_reactions");
    const shadows = new Set(
      previous
        .prepare("PRAGMA table_list")
        .all()
        .flatMap((row) =>
          row.type === "shadow" && typeof row.name === "string" ? [row.name] : [],
        ),
    );
    const ddl = previous
      .prepare(
        "SELECT tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY rowid",
      )
      .all()
      .flatMap((row) =>
        typeof row.sql === "string" &&
        typeof row.tbl_name === "string" &&
        !shadows.has(row.tbl_name)
          ? [row.sql]
          : [],
      )
      .join(";\n");
    fs.writeFileSync(filename, `${ddl};\n`);
  }
  vi.stubEnv("OPENCLAW_UPGRADE_SURVIVOR_BULK_BASELINE_SCHEMA", filename);
  const { observation, range, receipt } = await migrate(
    "same-version",
    target,
    readBaselineSchema(target),
  );
  expect(sameVersionRepairObserved).toBe(true);
  expect(range).toMatchObject({ fromVersion: target, toVersion: target });
  expect(receipt.violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ table: "transcript_events", sql: forbiddenSql }),
    ]),
  );
  expect(() => assertMigrationBulkSafe(observation, range)).toThrow(/bulk-data/u);
});
