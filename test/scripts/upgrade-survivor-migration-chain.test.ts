import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  assertMigrationBulkSafe,
  classifyMigrationBulkAccess,
} from "../../scripts/e2e/lib/upgrade-survivor/sqlite-bulk-access.mts";
import { installSqliteMigrationObserver } from "../../scripts/e2e/lib/upgrade-survivor/sqlite-migration-observer.mts";

// Loading-boundary test: static owner imports would capture native APIs before instrumentation.
const observer = installSqliteMigrationObserver();
await observer.qualifyNativeBindings().catch((error: unknown) => {
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
const original = {
  ...integrity,
  ...worker,
  finishAgentSchemaMigration: helpers.finishAgentSchemaMigration,
};
const configuredBaseline = Number(
  process.env.OPENCLAW_UPGRADE_SURVIVOR_BULK_BASELINE ?? target - 1,
);
let fixtureBulkStep = false;
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
  vi.spyOn(helpers, "finishAgentSchemaMigration").mockImplementation((...args) => {
    if (fixtureBulkStep) {
      args[0].exec("UPDATE transcript_events SET event_json=event_json WHERE 0");
    }
    return observer.withOwnerIntegrity("finishAgentSchemaMigration", () =>
      original.finishAgentSchemaMigration(...args),
    );
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => observer.dispose());

async function migrate(bulk: boolean, baseline: number) {
  fixtureBulkStep = bulk;
  expect(Number.isInteger(baseline) && baseline > 0 && baseline <= target).toBe(true);
  return withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const options = { agentId: "main", env };
    const pathname = resolveOpenClawAgentSqlitePath(options);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    {
      using db = new DatabaseSync(pathname);
      db.exec(getOpenClawAgentMigrationSchema(baseline));
      seedVersion(db, baseline);
      db.exec(`INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at)
          VALUES ('agent:main:test','test','{"sessionId":"test","updatedAt":1,"visibility":"shared","delivery":{"kind":"none"}}',1,1);
        INSERT INTO session_windows(session_id,session_key,created_at,updated_at) VALUES ('test','agent:main:test',1,1);
        INSERT INTO transcript_events(session_id,seq,event_json,created_at)
          VALUES ('test',1,'{"type":"message","message":{"role":"user","content":"retained"}}',1);
        ANALYZE;`);
    }
    // Lease admission is outside SQL observation; the real migration retains that lease throughout.
    const { observation } = await withAgentDatabaseMaintenanceLease(options, (maintenance) =>
      observer.observe(() =>
        migrateOpenClawAgentDatabaseForMaintenance({ ...options, pathname }, maintenance),
      ),
    );
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
    process.env.OPENCLAW_UPGRADE_SURVIVOR_BULK_FIXTURE_STEP === "1",
    configuredBaseline,
  );
  if (process.env.OPENCLAW_UPGRADE_SURVIVOR_BULK_RECEIPT) {
    fs.writeFileSync(
      process.env.OPENCLAW_UPGRADE_SURVIVOR_BULK_RECEIPT,
      JSON.stringify(
        {
          previousSource: process.env.OPENCLAW_SCHEMA_DOWNGRADE_BASE_SHA,
          candidateSource: process.env.GIT_COMMIT,
          ...range,
          ...receipt,
        },
        null,
        2,
      ),
    );
  }
  assertMigrationBulkSafe(observation, range);
});
it("rejects a real WHERE 0 fixture step before the delegated finalizer", async () => {
  const { observation, range, receipt } = await migrate(true, target - 1);
  expect(receipt.violations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ table: "transcript_events", store: "agent/main" }),
    ]),
  );
  expect(() => assertMigrationBulkSafe(observation, range)).toThrow(/agent\/main.*bulk-data/u);
});
