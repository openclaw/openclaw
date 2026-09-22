// Doctor session SQLite tests exercise real temp stores and per-agent SQLite files.
import { AsyncResource } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { recordOpenClawDatabaseQuarantine } from "../state/openclaw-quarantine-store.js";
import { readPersistedQuarantineRow } from "../state/openclaw-quarantine-store.test-support.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createSessionSqliteMigrationRun } from "./doctor-session-sqlite-migration-run.js";
import {
  readOnlySqliteValidationSnapshot,
  resolveTargetSqlitePath,
} from "./doctor-session-sqlite-readers.js";
import { recoverDoctorSessionSqliteTargets } from "./doctor-session-sqlite-recover-report.js";
import { createDoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { useDoctorSessionSqliteTestFixture } from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore, createImportedStoreForCompaction } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it.each([false, true])(
    "compacts and repairs canonical indexes in place (shared store: %s)",
    async (shared) => {
      const { sqlitePath, store } = await createImportedStoreForCompaction(shared);
      const selection = {
        env: store.env,
        store: store.storePath,
        ...(shared ? { agent: "beta" } : {}),
      };
      const compact = await runDoctorSessionSqlite({ ...selection, mode: "compact" });
      expect(compact.totals.issues).toBe(0);
      expect(compact.targets[0]?.compact?.skipped).toBe(false);
      createCanonicalCacheIndexDrift(sqlitePath);
      expect(
        recordOpenClawDatabaseQuarantine({
          env: store.env,
          kind: "agent",
          path: sqlitePath,
          reason: "canonical cache index drift",
        }),
      ).toBe(true);

      const report = await runDoctorSessionSqlite({
        ...selection,
        mode: "recover",
      });

      expect(report.totals.issues).toBe(0);
      expect(report.targets[0]?.corruptRecovery).toBeUndefined();
      expect(fs.existsSync(sqlitePath)).toBe(true);
      expect(readPersistedQuarantineRow(sqlitePath, { env: store.env })).toBeUndefined();

      const sqlite = nodeSqlite.requireNodeSqlite();
      const database = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
      try {
        expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
        expect(
          database
            .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
            .get("doctor", "canonical-index"),
        ).toEqual({ value_json: '{"ok":true}' });
      } finally {
        database.close();
      }
      expect(
        openOpenClawAgentDatabase({
          agentId: shared ? "alpha" : "main",
          env: store.env,
          path: sqlitePath,
        }).db.isOpen,
      ).toBe(true);
    },
  );

  it("fences quarantine clearing and later recovery targets after an awaited repair loses maintenance", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    createCanonicalCacheIndexDrift(sqlitePath);
    const laterPath = resolveOpenClawAgentSqlitePath({ agentId: "later", env: store.env });
    fs.mkdirSync(path.dirname(laterPath), { recursive: true });
    const laterBytes = Buffer.from("synthetic corrupt database\n");
    fs.writeFileSync(laterPath, laterBytes, { mode: 0o600 });
    for (const databasePath of [sqlitePath, laterPath]) {
      expect(
        recordOpenClawDatabaseQuarantine({
          env: store.env,
          kind: "agent",
          path: databasePath,
          reason: "synthetic recovery quarantine",
        }),
      ).toBe(true);
    }
    const quarantineBefore = [sqlitePath, laterPath].map((databasePath) =>
      readPersistedQuarantineRow(databasePath, { env: store.env }),
    );
    const agentDatabase = await import("../state/openclaw-agent-db.js");
    const migrate = agentDatabase.migrateOpenClawAgentDatabaseForMaintenance;
    // The competitor must not inherit the maintenance authority being revoked.
    const claimCompetingLease = AsyncResource.bind(claimOpenClawAgentDatabaseLease);
    let competingLeaseId: string | undefined;
    const repair = vi
      .spyOn(agentDatabase, "migrateOpenClawAgentDatabaseForMaintenance")
      .mockImplementationOnce(async (options, maintenance) => {
        await migrate(options, maintenance);
        // Lose the real owner at the caller's new await boundary, after native repair succeeds.
        const removed = openOpenClawStateDatabase({ env: store.env })
          .db.prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
          .run(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
        expect(removed.changes).toBe(1);
        competingLeaseId = claimCompetingLease({
          agentId: "later",
          path: laterPath,
          env: store.env,
        });
      });
    try {
      await expect(
        recoverDoctorSessionSqliteTargets({
          env: store.env,
          options: { mode: "recover" },
          targets: [
            { agentId: "main", storePath: sqlitePath },
            { agentId: "later", storePath: laterPath },
          ],
          validateTarget: async () => {
            throw new Error("Expected direct recovery without a failed migration manifest");
          },
        }),
      ).rejects.toThrow(/maintenance lease.*was lost/iu);
      expect(competingLeaseId).toBeDefined();
      expect(
        [sqlitePath, laterPath].map((databasePath) =>
          readPersistedQuarantineRow(databasePath, { env: store.env }),
        ),
      ).toEqual(quarantineBefore);
      expect(fs.readFileSync(laterPath)).toEqual(laterBytes);
      expect(
        fs.readdirSync(path.dirname(laterPath)).some((name) => name.includes(".corrupt-")),
      ).toBe(false);
    } finally {
      repair.mockRestore();
      if (competingLeaseId) {
        releaseOpenClawAgentDatabaseLease(competingLeaseId, { env: store.env });
      }
    }
  });

  it.each(["newer schema", "mismatched older schema", "I/O error"] as const)(
    "keeps canonical-index repair failures in place after %s",
    async (failure) => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      createCanonicalCacheIndexDrift(sqlitePath);
      if (failure !== "I/O error") {
        const version = failure === "newer schema" ? OPENCLAW_AGENT_SCHEMA_VERSION + 1 : 1;
        const database = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(sqlitePath);
        try {
          database.exec(`PRAGMA user_version = ${version};`);
          database
            .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
            .run(failure === "newer schema" ? version : 2);
        } finally {
          database.close();
        }
      }
      const before = fs.readFileSync(sqlitePath);
      const openDatabase = nodeSqlite.openNodeSqliteDatabase;
      const openSpy =
        failure === "I/O error"
          ? vi
              .spyOn(nodeSqlite, "openNodeSqliteDatabase")
              .mockImplementation((pathname, options) => {
                if (pathname === sqlitePath && options?.readOnly !== true) {
                  throw Object.assign(new Error("injected maintenance I/O failure"), {
                    code: "EIO",
                  });
                }
                return openDatabase(pathname, options);
              })
          : undefined;
      let report: Awaited<ReturnType<typeof runDoctorSessionSqlite>>;
      try {
        report = await runDoctorSessionSqlite({
          env: store.env,
          mode: "recover",
          store: store.storePath,
        });
      } finally {
        openSpy?.mockRestore();
      }
      expect(report.targets[0]?.issues).toMatchObject([{ code: "sqlite_recovery_inspect_failed" }]);
      expect(report.targets[0]?.corruptRecovery).toBeUndefined();
      expect(fs.readFileSync(sqlitePath)).toEqual(before);
      expect(
        fs.readdirSync(path.dirname(sqlitePath)).some((entry) => entry.includes(".corrupt-")),
      ).toBe(false);
    },
  );

  it("validates the trusted SQLite override when recovering a migration manifest", async () => {
    const store = createLegacyStore();
    const target = {
      agentId: "main",
      sqlitePath: path.join(store.stateDir, "migration-target.sqlite"),
      storePath: store.storePath,
    };
    await upsertSessionEntryCore(
      {
        agentId: target.agentId,
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: target.sqlitePath,
      },
      { sessionId: "session-1", updatedAt: 1 },
    );
    const run = createSessionSqliteMigrationRun(store.env, [target]);
    const report = await recoverDoctorSessionSqliteTargets({
      env: store.env,
      options: { mode: "recover" },
      targets: [target],
      validateTarget: async (selected) => {
        const validation = readOnlySqliteValidationSnapshot(selected);
        if (!validation.ok) {
          throw validation.error;
        }
        return createDoctorSessionSqliteTargetReport({
          ...selected,
          sqlitePath: resolveTargetSqlitePath(selected),
          validatedEntries: validation.snapshot.sessionIdsBySessionKey.size,
        });
      },
    });
    expect(report.migrationRun?.manifestPath).toBe(run.manifestPath);
    expect(report.targets[0]?.sqlitePath).toBe(target.sqlitePath);
    expect(report.totals.validatedEntries).toBe(1);
  });

  it.skipIf(process.platform === "win32")(
    "reapplies owner-only permissions after compaction",
    async () => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      fs.chmodSync(sqlitePath, 0o666);

      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "compact",
        store: store.storePath,
      });

      expect(report.totals.issues).toBe(0);
      expect(fs.statSync(sqlitePath).mode & 0o777).toBe(0o600);
    },
  );

  it("rejects stale secondary indexes before compacting and quarantines them in recovery", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    createUnsafeIndexDrift(sqlitePath);
    expect(
      recordOpenClawDatabaseQuarantine({
        env: store.env,
        kind: "agent",
        path: sqlitePath,
        reason: "stale secondary index",
      }),
    ).toBe(true);

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "compact",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "sqlite_compact_failed",
          message: expect.stringMatching(
            /integrity_check failed.*missing from index unsafe_session_index/iu,
          ),
        }),
      ]),
    );
    expect(readPersistedQuarantineRow(sqlitePath, { env: store.env })?.reason).toBe(
      "stale secondary index",
    );

    const recovery = await runDoctorSessionSqlite({
      env: store.env,
      mode: "recover",
      store: store.storePath,
    });
    expect(recovery.totals.issues).toBe(0);
    expect(recovery.targets[0]?.corruptRecovery?.movedFiles).toEqual(
      expect.arrayContaining([expect.stringMatching(/openclaw-agent\.sqlite\.corrupt-/u)]),
    );
    expect(fs.existsSync(sqlitePath)).toBe(false);
  });
});

function createUnsafeIndexDrift(sqlitePath: string): void {
  const sqlite = nodeSqlite.requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      CREATE TABLE unsafe_session_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_session_index
      ON unsafe_session_index_records(indexed_value);
      INSERT INTO unsafe_session_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_session_index ON unsafe_session_index_records(alternate_value)' WHERE name = 'unsafe_session_index'",
      )
      .run();
    database.exec("PRAGMA writable_schema = OFF;");
    const schemaVersionRow = database.prepare("PRAGMA schema_version;").get() as
      | Record<string, unknown>
      | undefined;
    const schemaVersion = Number(
      schemaVersionRow?.schema_version ??
        (schemaVersionRow ? Object.values(schemaVersionRow)[0] : undefined),
    );
    database.exec(`PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

function createCanonicalCacheIndexDrift(sqlitePath: string): void {
  const sqlite = nodeSqlite.requireNodeSqlite();
  const database = new sqlite.DatabaseSync(sqlitePath);
  try {
    database.exec(`
      INSERT INTO cache_entries (scope, key, value_json, expires_at, updated_at)
      VALUES ('doctor', 'canonical-index', '{"ok":true}', 100, 1);
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        `UPDATE sqlite_schema
            SET sql = 'CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL'
          WHERE name = 'idx_agent_cache_expiry'`,
      )
      .run();
    database.exec("PRAGMA writable_schema = OFF;");
    const schemaVersionRow = database.prepare("PRAGMA schema_version;").get() as
      | Record<string, unknown>
      | undefined;
    const schemaVersion = Number(
      schemaVersionRow?.schema_version ??
        (schemaVersionRow ? Object.values(schemaVersionRow)[0] : undefined),
    );
    database.exec(`PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}
