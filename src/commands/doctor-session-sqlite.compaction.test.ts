import { AsyncResource } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore as upsertEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { createSessionSqliteMigrationRun } from "../infra/session-sqlite-migration-manifest.js";
import {
  readOnlySqliteValidationSnapshot,
  resolveTargetSqlitePath,
} from "../infra/session-sqlite-migration-readers.js";
import { readAgentDatabaseDeletionSnapshot } from "../state/agent-deletion-journal.read.js";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesForTest as closeAgentHandles,
  openOpenClawAgentDatabase as openAgentDatabase,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  resolveOpenClawAgentSqlitePath as resolveAgentPath,
} from "../state/openclaw-agent-db.js";
import {
  readPersistedQuarantineRow as readQuarantine,
  seedOpenClawDatabaseQuarantine as seedQuarantine,
} from "../state/openclaw-quarantine-store.test-support.js";
import {
  closeOpenClawStateDatabaseForTest as closeStateHandles,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { recoverDoctorSessionSqliteTargets } from "./doctor-session-sqlite-recover-report.js";
import { createDoctorSessionSqliteTargetReport } from "./doctor-session-sqlite-types.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { sessionSqlFixture } from "./doctor-session-sqlite.sql.test-support.js";
import {
  importLegacyStore,
  useDoctorSessionSqliteTestFixture,
  readMigrationManifest,
} from "./doctor-session-sqlite.test-support.js";

const { createLegacyStore, createImportedStoreForCompaction, autoCleanupTempDirs } =
  useDoctorSessionSqliteTestFixture();

function runStore(
  store: Parameters<typeof importLegacyStore>[0],
  mode: "compact" | "recover" = "compact",
) {
  return runDoctorSessionSqlite({ env: store.env, mode, store: store.storePath });
}
function quarantine(
  store: Parameters<typeof importLegacyStore>[0],
  databasePath: string,
  reason: string,
) {
  seedQuarantine({ env: store.env, kind: "agent", path: databasePath, reason });
}
function expectCompactionFailure(
  report: Awaited<ReturnType<typeof runDoctorSessionSqlite>>,
  message: RegExp,
) {
  expect(report.targets[0]?.issues).toEqual([
    expect.objectContaining({
      code: "sqlite_compact_failed",
      message: expect.stringMatching(message),
    }),
  ]);
}

function withSqlite<T>(
  sqlitePath: string,
  use: (database: DatabaseSync) => T,
  readOnly = false,
): T {
  using database = new (nodeSqlite.requireNodeSqlite().DatabaseSync)(sqlitePath, { readOnly });
  return use(database);
}

function expectDatabase(
  sqlitePath: string,
  rows: Record<string, unknown>,
  lists: Record<string, unknown> = {},
) {
  withSqlite(
    sqlitePath,
    (database) => {
      for (const [query, expected] of Object.entries(rows)) {
        expect(database.prepare(query).get()).toEqual(expected);
      }
      for (const [query, expected] of Object.entries(lists)) {
        expect(database.prepare(query).all()).toEqual(expected);
      }
    },
    true,
  );
}

describe("runDoctorSessionSqlite", () => {
  it.each(["NONE", "INCREMENTAL"] as const)(
    "finalizes imports from auto_vacuum=%s without unnecessary repacking",
    async (autoVacuum) => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      fs.writeFileSync(store.storePath, "{}\n");
      const database = nodeSqlite.openNodeSqliteDatabase(sqlitePath);
      const sql = sessionSqlFixture(database);
      let freelistBefore: number;
      try {
        database.exec(`PRAGMA auto_vacuum = ${autoVacuum}; VACUUM;
          CREATE TABLE cleanup_payload (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
          CREATE TABLE cleanup_discard (body BLOB);
          BEGIN;`);
        const insert = sql`INSERT INTO cleanup_payload VALUES (?, ?)`;
        for (let index = 0; index < 1000; index++) {
          insert.run(index, "x".repeat(1000));
        }
        // Keep partially filled pages as well as completely freed pages: only full
        // compaction should repack the former when pointer maps already exist.
        database.exec(`COMMIT; UPDATE cleanup_payload SET body = 'keep';
          INSERT INTO cleanup_discard VALUES (zeroblob(1048576));
          DELETE FROM cleanup_discard; PRAGMA wal_checkpoint(TRUNCATE);`);
        freelistBefore = Number(sql`PRAGMA freelist_count`.get()?.freelist_count);
      } finally {
        database.close();
      }
      const imported = await importLegacyStore(store);
      expect(imported.totals.issues).toBe(0);
      const cleanup = expectDefined(imported.targets[0]?.compact, "import cleanup");
      expect(cleanup).toMatchObject({ freelistAfterPages: 0, skipped: false });
      expect(freelistBefore).toBeGreaterThan(0);
      expect(cleanup.freelistBeforePages).toBeGreaterThan(0);
      expect(cleanup.reclaimedBytes).toBeGreaterThan(0);
      quarantine(store, sqlitePath, "corrupt index");
      const externalStorePath = path.join(store.tempDir, "external-sessions.json");
      if (process.platform !== "win32") {
        fs.writeFileSync(store.storePath, "{}\n", { mode: 0o600 });
        fs.linkSync(store.storePath, externalStorePath);
        fs.chmodSync(sqlitePath, 0o666);
      }
      const compacted = await runStore(store);
      expect(compacted.totals.issues).toBe(0);
      const packed = expectDefined(compacted.targets[0]?.compact, "explicit compaction");
      expect(packed).toMatchObject({ freelistAfterPages: 0, skipped: false });
      if (autoVacuum === "NONE") {
        expect(packed.dbSizeAfterBytes).toBe(cleanup.dbSizeAfterBytes);
      } else {
        expect(packed.dbSizeAfterBytes).toBeLessThan(cleanup.dbSizeAfterBytes);
        expect(compacted.totals.reclaimedBytes).toBeGreaterThan(0);
      }
      const after = nodeSqlite.openNodeSqliteDatabase(sqlitePath, { readOnly: true });
      const afterSql = sessionSqlFixture(after);
      try {
        expect(afterSql`PRAGMA auto_vacuum`.get()).toEqual({ auto_vacuum: 2 });
        expect(afterSql`PRAGMA integrity_check`.get()).toEqual({ integrity_check: "ok" });
        expect(afterSql`PRAGMA foreign_key_check`.all()).toEqual([]);
        expect(afterSql`SELECT id, body FROM cleanup_payload ORDER BY id`.all()).toEqual(
          Array.from({ length: 1000 }, (_, id) => ({ id, body: "keep" })),
        );
      } finally {
        after.close();
      }
      expect(readQuarantine(sqlitePath, { env: store.env })).toBeUndefined();
      if (process.platform !== "win32") {
        expect(fs.statSync(sqlitePath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(externalStorePath).nlink).toBe(2);
        expect(fs.readFileSync(externalStorePath, "utf8")).toBe("{}\n");
      }
      expect(openAgentDatabase({ agentId: "main", env: store.env }).db.isOpen).toBe(true);
    },
  );

  it("preserves the typed maintenance cause when import finalization fails", async () => {
    const store = createLegacyStore();
    fs.writeFileSync(store.storePath, "{}\n");
    openAgentDatabase({ agentId: "main", env: store.env });
    closeAgentHandles();
    closeStateHandles();
    const openDatabase = nodeSqlite.openNodeSqliteDatabase;
    const sharedPath = resolveOpenClawStateSqlitePath(store.env);
    const sharedFileUri = nodeSqlite.resolveExistingSqliteFileUri(sharedPath);
    const spy = vi
      .spyOn(nodeSqlite, "openNodeSqliteDatabase")
      .mockImplementation((file, options) => {
        if ((file === sharedPath || file === sharedFileUri) && !options?.readOnly) {
          throw Object.assign(new Error("fixture lease storage failure"), { code: "SQLITE_IOERR" });
        }
        return openDatabase(file, options);
      });
    try {
      const report = await importLegacyStore(store);
      expect(report.targets[0]?.issues).toContainEqual(
        expect.objectContaining({
          code: "sqlite_compact_failed",
          message: expect.stringContaining("fixture lease storage failure | SQLITE_IOERR"),
        }),
      );
      expect(fs.readFileSync(store.storePath, "utf8")).toBe("{}\n");
      const failureReportPath = expectDefined(
        report.migrationRun?.failureReportMarkdownPath,
        "failure report",
      );
      expect(fs.readFileSync(failureReportPath, "utf8")).toContain(
        "fixture lease storage failure | SQLITE_IOERR",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses compaction while this process owns an open agent database handle", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    openAgentDatabase({ agentId: "main", env: store.env, path: sqlitePath });

    const report = await runStore(store);

    expectCompactionFailure(report, /already open in this process/iu);
  });

  it("rejects wrong schema role before compaction", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    withSqlite(sqlitePath, (database) => {
      const sql = sessionSqlFixture(database);
      sql`UPDATE schema_meta SET role = 'global' WHERE meta_key = 'primary'`.run();
    });

    const report = await runStore(store);

    expect(report.targets[0]?.issues).toContainEqual(
      expect.objectContaining({
        code: "sqlite_compact_failed",
        message: expect.stringMatching(/schema role global.*expected agent/iu),
      }),
    );
  });
});

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
      quarantine(store, sqlitePath, "canonical cache index drift");

      const report = await runDoctorSessionSqlite({
        ...selection,
        mode: "recover",
      });

      expect(report.totals.issues).toBe(0);
      expect(report.targets[0]?.corruptRecovery).toBeUndefined();
      expect(fs.existsSync(sqlitePath)).toBe(true);
      expect(readQuarantine(sqlitePath, { env: store.env })).toBeUndefined();

      expectDatabase(sqlitePath, {
        "PRAGMA integrity_check": { integrity_check: "ok" },
        "SELECT value_json FROM cache_entries WHERE scope = 'doctor' AND key = 'canonical-index'": {
          value_json: '{"ok":true}',
        },
      });
      expect(
        openAgentDatabase({ agentId: shared ? "alpha" : "main", env: store.env, path: sqlitePath })
          .db.isOpen,
      ).toBe(true);
    },
  );

  it("fences quarantine clearing and later recovery targets after an awaited repair loses maintenance", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    createCanonicalCacheIndexDrift(sqlitePath);
    const laterPath = resolveAgentPath({ agentId: "later", env: store.env });
    fs.mkdirSync(path.dirname(laterPath), { recursive: true });
    const laterBytes = Buffer.from("synthetic corrupt database\n");
    fs.writeFileSync(laterPath, laterBytes, { mode: 0o600 });
    for (const databasePath of [sqlitePath, laterPath]) {
      quarantine(store, databasePath, "synthetic recovery quarantine");
    }
    const quarantineBefore = [sqlitePath, laterPath].map((databasePath) =>
      readQuarantine(databasePath, { env: store.env }),
    );
    const agentMaintenance = await import("../state/openclaw-agent-db-maintenance.js");
    const migrate = agentMaintenance.migrateOpenClawAgentDatabaseForMaintenance;
    // The competitor must not inherit the maintenance authority being revoked.
    const claimCompetingLease = AsyncResource.bind(claimOpenClawAgentDatabaseLease);
    let competingLeaseId: string | undefined;
    const repair = vi
      .spyOn(agentMaintenance, "migrateOpenClawAgentDatabaseForMaintenance")
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
          readQuarantine(databasePath, { env: store.env }),
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

  it.each(["newer schema", "mismatched older schema"] as const)(
    "keeps canonical-index repair failures in place after %s",
    async (failure) => {
      const { sqlitePath, store } = await createImportedStoreForCompaction();
      createCanonicalCacheIndexDrift(sqlitePath);
      const version = failure === "newer schema" ? OPENCLAW_AGENT_SCHEMA_VERSION + 1 : 1;
      withSqlite(sqlitePath, (database) => {
        const sql = sessionSqlFixture(database);
        database.exec(`PRAGMA user_version = ${version};`);
        sql`UPDATE schema_meta SET schema_version = ${failure === "newer schema" ? version : 2} WHERE meta_key = 'primary'`.run();
      });
      const before = fs.readFileSync(sqlitePath);
      const report = await runStore(store, "recover");
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
    await upsertEntry(
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

  it("rejects stale secondary indexes before compacting and quarantines them in recovery", async () => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    createUnsafeIndexDrift(sqlitePath);
    quarantine(store, sqlitePath, "stale secondary index");

    const report = await runStore(store);

    expect(report.targets[0]?.issues).toContainEqual(
      expect.objectContaining({
        code: "sqlite_compact_failed",
        message: expect.stringMatching(
          /integrity_check failed.*missing from index unsafe_session_index/iu,
        ),
      }),
    );
    expect(readQuarantine(sqlitePath, { env: store.env })?.reason).toBe("stale secondary index");

    const recovery = await runStore(store, "recover");
    expect(recovery.totals.issues).toBe(0);
    expect(recovery.targets[0]?.corruptRecovery?.movedFiles).toEqual(
      expect.arrayContaining([expect.stringMatching(/openclaw-agent\.sqlite\.corrupt-/u)]),
    );
    expect(fs.existsSync(sqlitePath)).toBe(false);
  });
});

function rewriteIndexSchema(database: DatabaseSync, query: string) {
  database.enableDefensive?.(false);
  database.exec("PRAGMA writable_schema = ON;");
  database.prepare(query).run();
  database.exec("PRAGMA writable_schema = OFF;");
  const row = sql`PRAGMA schema_version;`.get();
  const version = Number(row?.schema_version ?? (row ? Object.values(row)[0] : undefined));
  database.exec(`PRAGMA schema_version = ${version + 1};`);
}

function createUnsafeIndexDrift(sqlitePath: string): void {
  withSqlite(sqlitePath, (database) => {
    database.exec(`
      CREATE TABLE unsafe_session_index_records (indexed_value TEXT, alternate_value TEXT);
      CREATE INDEX unsafe_session_index ON unsafe_session_index_records(indexed_value);
      INSERT INTO unsafe_session_index_records VALUES ('alpha', 'zeta');
    `);
    rewriteIndexSchema(
      database,
      "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_session_index ON unsafe_session_index_records(alternate_value)' WHERE name = 'unsafe_session_index'",
    );
  });
}

function createCanonicalCacheIndexDrift(sqlitePath: string): void {
  withSqlite(sqlitePath, (database) => {
    database.exec(`
      INSERT INTO cache_entries (scope, key, value_json, expires_at, updated_at)
      VALUES ('doctor', 'canonical-index', '{"ok":true}', 100, 1);
      DROP INDEX idx_agent_cache_expiry;
      CREATE INDEX idx_agent_cache_expiry ON cache_entries(key);
    `);
    rewriteIndexSchema(
      database,
      `UPDATE sqlite_schema
            SET sql = 'CREATE INDEX idx_agent_cache_expiry ON cache_entries(scope, expires_at, key) WHERE expires_at IS NOT NULL'
          WHERE name = 'idx_agent_cache_expiry'`,
    );
  });
}

describe("runDoctorSessionSqlite", () => {
  it("imports zero legacy records without parsing canonical entry JSON", async () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-empty-import-");
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, "{}\n", { mode: 0o600 });
    const database = openAgentDatabase({ agentId: "main", env });
    const agentSql = sessionSqlFixture(database.db);
    const entryJson = JSON.stringify({
      payload: "empty-import-sentinel".repeat(64 * 1024),
      sessionId: "canonical-only-session",
      updatedAt: 19,
    });
    agentSql`INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (${"agent:main:main"}, ${"canonical-only-session"}, ${entryJson}, ${19})`.run();
    agentSql`UPDATE session_nodes SET entry_valid = 1`.run();
    const sqlitePath = database.path;
    closeAgentHandles();
    const parseSpy = vi.spyOn(JSON, "parse");
    try {
      const report = await runDoctorSessionSqlite({ env, mode: "import", store: storePath });
      expect(report.totals).toMatchObject({
        importedEntries: 0,
        issues: 0,
        legacyEntries: 0,
        sqliteEntries: 1,
      });
      expect(parseSpy.mock.calls.some(([value]) => value === entryJson)).toBe(false);
    } finally {
      parseSpy.mockRestore();
    }
    expectDatabase(sqlitePath, {
      "SELECT entry_json FROM session_nodes": { entry_json: entryJson },
    });
  });

  it.each(["dry-run", "sqlite-only", "directory"] as const)(
    "inspects %s stores without mutating them",
    async (kind) => {
      const legacy = kind !== "sqlite-only" ? createLegacyStore() : undefined;
      const stateDir = legacy?.stateDir ?? autoCleanupTempDirs.make("openclaw-doctor-inspection-");
      const storePath =
        legacy?.storePath ?? path.join(stateDir, "agents/main/sessions", "sessions.json");
      const env = legacy?.env ?? { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      if (kind === "sqlite-only") {
        await upsertEntry(
          { agentId: "main", env, sessionKey: "agent:main:main", storePath },
          { sessionId: "sqlite-session", updatedAt: 1 },
        );
      }
      const report = await runDoctorSessionSqlite({
        env,
        mode: kind === "dry-run" ? "dry-run" : "inspect",
        ...(kind === "sqlite-only"
          ? { allAgents: true, cfg: {} }
          : { store: kind === "directory" ? path.dirname(storePath) : storePath }),
      });
      if (kind === "directory") {
        expect(report.targets[0]?.issues).toEqual([
          expect.objectContaining({
            code: "store_unreadable",
            message: expect.stringContaining("not a regular file"),
          }),
        ]);
        return;
      }
      expect(report.totals).toMatchObject({
        issues: 0,
        legacyEntries: kind === "sqlite-only" ? 0 : 1,
        sqliteEntries: kind === "sqlite-only" ? 1 : 0,
        targets: 1,
        ...(kind === "dry-run"
          ? {
              importedEntries: 0,
              importedTranscriptEvents: 0,
              unreferencedJsonlFiles: 2,
              validatedEntries: 1,
              validatedTranscriptEvents: 2,
            }
          : {}),
      });
      if (kind === "sqlite-only") {
        expect(fs.existsSync(storePath)).toBe(false);
      } else {
        expect(report.targets[0]?.sqlitePath).toBeTruthy();
        expect(fs.existsSync(report.targets[0]?.sqlitePath ?? "")).toBe(false);
      }
    },
  );

  it("migrates a dormant historical agent database before all-agent import compaction", async () => {
    const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-");
    const stateDir = path.join(tempDir, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    // This migration fixture has known-empty deletion history, not orphaned retained SQLite.
    openOpenClawStateDatabase({ env });
    expect(readAgentDatabaseDeletionSnapshot(env)?.retainedDeletions).toEqual({ status: "empty" });
    const agentIds = ["dormant", "current"] as const;
    for (const agentId of agentIds) {
      const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}\n", { mode: 0o600 });
    }
    const dormantPath = createHistoricalV1AgentDatabase({ agentId: "dormant", env });
    const currentPath = openAgentDatabase({ agentId: "current", env }).path;
    closeAgentHandles();

    const sqlite = nodeSqlite.requireNodeSqlite();
    const currentBefore = new sqlite.DatabaseSync(currentPath);
    const currentSql = sessionSqlFixture(currentBefore);
    const currentUpdatedAt = expectDefined(
      currentSql`SELECT updated_at FROM schema_meta WHERE meta_key = 'primary'`.get() as
        | { updated_at?: number }
        | undefined,
      "current schema metadata",
    ).updated_at;
    currentBefore.close();

    const report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: { agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) } },
      env,
      mode: "import",
    });

    expect(report.totals).toMatchObject({ importedEntries: 0, issues: 0, targets: 2 });
    expect(report.targets.find((target) => target.agentId === "dormant")?.compact).toMatchObject({
      skipped: false,
    });
    expectDatabase(
      dormantPath,
      {
        "PRAGMA user_version": { user_version: OPENCLAW_AGENT_SCHEMA_VERSION },
        "SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'": {
          schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
        "PRAGMA integrity_check": { integrity_check: "ok" },
      },
      { "PRAGMA foreign_key_check": [] },
    );
    withSqlite(
      dormantPath,
      (dormantAfter) => {
        const dormantSql = sessionSqlFixture(dormantAfter);
        expect(
          dormantSql`PRAGMA table_info(session_windows)`
            .all()
            .map((column) => (column as { name?: unknown }).name),
        ).toContain("session_scope");
        expect(
          dormantSql`PRAGMA table_info(memory_index_sources)`
            .all()
            .map((column) => (column as { name?: unknown }).name),
        ).toEqual(["id", "path", "source", "hash", "mtime", "size"]);
      },
      true,
    );
    expectDatabase(currentPath, {
      "SELECT schema_version, updated_at FROM schema_meta WHERE meta_key = 'primary'": {
        schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        updated_at: currentUpdatedAt,
      },
    });
  });

  it("keeps mismatched older agent schema versions blocking during all-agent import", async () => {
    const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-");
    const stateDir = path.join(tempDir, "token=supersecret", "state");
    const sessionsDir = path.join(stateDir, "agents", "drifted", "sessions");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}\n", { mode: 0o600 });
    const sqlitePath = openAgentDatabase({ agentId: "drifted", env }).path;
    closeAgentHandles();

    withSqlite(sqlitePath, (database) => {
      const sql = sessionSqlFixture(database);
      database.exec("PRAGMA user_version = 1;");
      sql`UPDATE schema_meta SET schema_version = 2 WHERE meta_key = 'primary'`.run();
    });

    const report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: { agents: { entries: { drifted: {} } } },
      env,
      mode: "import",
    });

    expectCompactionFailure(report, /uses schema version 1/iu);
    const manifest = readMigrationManifest(report.migrationRun?.manifestPath);
    expect(manifest.failedAt).toBeTruthy();
    expect(manifest.failureReports).toBeDefined();
    const failureReportPath = expectDefined(
      report.migrationRun?.failureReportMarkdownPath,
      "blocking migration failure report path",
    );
    const failureReport = fs.readFileSync(failureReportPath, "utf-8");
    expect(failureReport).toContain("sqlite_compact_failed");
    expect(failureReport).toContain("openclaw doctor --session-sqlite recover --github-issue");
    expect(failureReport).not.toContain("supersecret");
    expectDatabase(sqlitePath, {
      "PRAGMA user_version": { user_version: 1 },
      "SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'": { schema_version: 2 },
    });
  });
});

// Use the shipped July schema so Doctor owns the upgrade. Empty session tables
// preserve the dormant-agent case: import has no rows to open before compaction.
function createHistoricalV1AgentDatabase(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
}): string {
  const sqlitePath = resolveAgentPath(params);
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  withSqlite(sqlitePath, (database) => {
    database.exec(
      fs.readFileSync(
        new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v1.sql", import.meta.url),
        "utf8",
      ),
    );
    database.exec("PRAGMA user_version = 1;");
    database
      .prepare(
        `
          INSERT INTO schema_meta
            (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
          VALUES ('primary', 'agent', 1, ?, NULL, 1, 1)
        `,
      )
      .run(params.agentId);
  });
  return sqlitePath;
}
