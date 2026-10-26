import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as sqlite from "../infra/node-sqlite.js";
import { readSqliteDatabaseIntegrityVerification } from "../infra/sqlite-database-admission.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import { inspectScopedMigrationSnapshot } from "../infra/sqlite-migration-scoped-snapshot.js";
import { prepareAgentDatabaseMigrationDiscovery } from "../infra/state-migrations.media-persistence-targets.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { readUpdateDatabaseGenerations } from "../infra/update-database-generations.js";
import { createUpdateDoctorDatabaseWriteCapture } from "../infra/update-doctor-result.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import * as agentSchema from "../state/openclaw-agent-db-schema.js";
import { getOpenClawAgentDatabaseValidationForTransfer } from "../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { preflightOpenClawDatabaseSchemas } from "../state/openclaw-database-preflight.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveSchemaMigrationBackupTables } from "../state/schema-migration-backup-scope.js";
import { assertSqliteMigrationScopePreserved } from "../state/sqlite-migration-scope.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { assertDoctorMaintenanceReady } from "./doctor-maintenance-inspection.js";
import { restoreDoctorMigrationBackup } from "./doctor-migration-backup-restore.js";
import { prepareDoctorDatabaseMigrations } from "./doctor-schema-migrations.js";
import { withMaintenance } from "./doctor-schema-migrations.test-support.js";

function openLegacyDatabase(pathname: string, version = 26, agentId = "main") {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const database = new DatabaseSync(pathname);
  database.exec(
    fs.readFileSync(
      new URL(`../../test/fixtures/sqlite/openclaw-agent-schema-v${version}.sql`, import.meta.url),
      "utf8",
    ),
  );
  database.exec(`PRAGMA user_version = ${version}`);
  database
    .prepare(`INSERT INTO schema_meta
    (meta_key, role, schema_version, agent_id, created_at, updated_at)
    VALUES ('primary', 'agent', ?, ?, 1, 1)`)
    .run(version, agentId);
  return database;
}

function migrationParams(
  env: NodeJS.ProcessEnv,
  pendingMigrations: (NonNullable<
    Parameters<typeof prepareDoctorDatabaseMigrations>[0]["pendingMigrations"]
  >[number] & { agentId: string })[],
) {
  const paths = pendingMigrations.map(({ path: pathname }) => pathname);
  return {
    env,
    pendingMigrations,
    pendingDatabasePaths: paths,
    databasePaths: paths,
    agentDatabaseTargets: pendingMigrations.map(({ agentId, path: pathname }) => ({
      agentId,
      path: pathname,
      realPath: pathname,
      source: "disk" as const,
    })),
  };
}

it("attributes version and additive schema preparation before admitting retained readers", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    openOpenClawStateDatabase({ env: state.env });
    const pathname = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
    {
      using database = openLegacyDatabase(pathname);
      database.exec("PRAGMA journal_mode = WAL; ALTER TABLE session_nodes DROP COLUMN project_id");
    }
    const warnings: string[] = [];
    const generations = readUpdateDatabaseGenerations([pathname]);
    const capture = createUpdateDoctorDatabaseWriteCapture(generations, {
      env: state.env,
      signal: new AbortController().signal,
      warn: (message) => warnings.push(message),
    })!;
    await withMaintenance(async () => {
      await capture.admit();
      await capture.run(async () => {
        const result = await prepareDoctorDatabaseMigrations(
          migrationParams(state.env, [
            {
              kind: "agent",
              agentId: "main",
              path: pathname,
              foundVersion: 26,
              supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
            },
          ]),
        );
        expect(result.warnings).toEqual([]);
        using reader = new DatabaseSync(pathname, { readOnly: true });
        expect(reader.prepare("SELECT project_id FROM session_nodes").all()).toEqual([]);
        const admitted = openOpenClawAgentDatabase({
          agentId: "main",
          path: pathname,
          env: state.env,
        });
        expect(admitted.db.prepare("SELECT project_id FROM session_nodes").all()).toEqual([]);
        await closeOpenClawAgentDatabasesAsync();
      });
      await capture.settle();
    });
    expect(warnings).toEqual([]);
    expect(capture.receipt).toMatchObject({ unchanged: true, fromGenerations: generations });
  });
});

it.each([
  { version: 24, check: undefined },
  { version: 24, check: "full" },
  { version: 26, check: undefined },
  { version: 26, check: "full" },
] as const)(
  "uses the requested upgrade integrity coverage before changing schema v$version ($check)",
  async ({ version, check }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      openOpenClawStateDatabase({ env: state.env });
      const pathname = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
      {
        using database = openLegacyDatabase(pathname, version);
        database.exec(`
          DROP INDEX idx_agent_cache_updated;
          CREATE INDEX idx_agent_cache_updated ON cache_entries(scope, key, updated_at);
          INSERT INTO cache_entries (scope, key, value_json, updated_at)
          VALUES ('retained', 'history', '"untouched"', 1);
        `);
        database.enableDefensive?.(false);
        database.exec("PRAGMA writable_schema = ON");
        database
          .prepare("UPDATE sqlite_schema SET sql = ? WHERE name = 'idx_agent_cache_updated'")
          .run(
            "CREATE INDEX idx_agent_cache_updated ON cache_entries(scope, updated_at DESC, key)",
          );
        database.exec("PRAGMA writable_schema = OFF");
      }
      fs.chmodSync(pathname, 0o600);
      const worker = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
      const migration = {
        kind: "agent" as const,
        agentId: "main",
        path: pathname,
        foundVersion: version,
        supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      };
      try {
        const result = withMaintenance(async () => {
          const preparedDiscovery = prepareAgentDatabaseMigrationDiscovery({
            env: state.env,
            configuredAgentDatabaseTargets: [{ agentId: "main", path: pathname }],
          });
          const prepared = await prepareDoctorDatabaseMigrations({
            ...migrationParams(state.env, [migration]),
            check,
          });
          expect(prepared.warnings).toEqual([]);
          preparedDiscovery.versionMigrations = prepared.versionMigrations;
          return migrateLegacyMediaPersistence({
            env: state.env,
            preparedDiscovery,
            integrityCheck: check,
          });
        });
        if (check === "full") {
          await expect(result).rejects.toThrow(/integrity_check.*idx_agent_cache_updated/su);
        } else {
          await expect(result).resolves.toMatchObject({ warnings: [] });
          if (version === 24) {
            // The byte-equal capture already checked this unchanged source.
            expect(worker.mock.calls.filter((call) => call[0] === pathname)).toHaveLength(0);
          }
        }
      } finally {
        worker.mockRestore();
      }
      using database = new DatabaseSync(pathname, { readOnly: true });
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
        check === "full" ? version : OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      expect(database.prepare("SELECT value_json FROM cache_entries").get()?.value_json).toBe(
        '"untouched"',
      );
    });
  },
);

it.each([
  { check: "quick", update: false },
  { check: "full", update: false },
  { check: "quick", update: true },
  { check: "full", update: true },
] as const)(
  "carries only full upgrade verification into runtime admission ($check, update=$update)",
  async ({ check, update }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      if (update) {
        state.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
      }
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: { systemAgent: { agentId: "main" } },
        },
        plugins: { enabled: false },
      };
      await state.writeConfig(cfg);
      openOpenClawStateDatabase({ env: state.env });
      const pathname = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
      const target = { agentId: "main", path: pathname };
      {
        using database = openLegacyDatabase(pathname);
        database.exec(`
          INSERT INTO cache_entries (scope, key, value_json, updated_at)
          VALUES ('retained', 'history', '"preserved"', 1);
        `);
      }
      let localFullChecks = 0;
      const open = sqlite.openNodeSqliteDatabase;
      vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
        const database = open(...args);
        if (args[0] === pathname) {
          const prepare = database.prepare.bind(database);
          vi.spyOn(database, "prepare").mockImplementation((sql) => {
            if (/^PRAGMA integrity_check;?$/.test(sql)) {
              localFullChecks += 1;
            }
            return prepare(sql);
          });
        }
        return database;
      });
      const worker = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
      const additiveSchema = vi.spyOn(agentSchema, "ensureOpenClawAgentSchema");
      const liveFullChecks = () =>
        localFullChecks +
        worker.mock.calls.filter((call) => call[0] === pathname && call[5]?.check !== "quick")
          .length;
      try {
        await withMaintenance(async () => {
          const preparedDiscovery = prepareAgentDatabaseMigrationDiscovery({
            env: state.env,
            configuredAgentDatabaseTargets: [target],
          });
          const result = await prepareDoctorDatabaseMigrations({
            ...migrationParams(state.env, [
              {
                kind: "agent",
                ...target,
                foundVersion: 26,
                supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
              },
            ]),
            check,
            agentDatabaseTargets: [{ ...target, realPath: pathname, source: "configured" }],
          });
          expect(result.warnings).toEqual([]);
          preparedDiscovery.versionMigrations = result.versionMigrations;
          additiveSchema.mockClear();
          expect(
            await migrateLegacyMediaPersistence({ env: state.env, preparedDiscovery }),
          ).toMatchObject({ warnings: [] });
          expect(additiveSchema).toHaveBeenCalledTimes(update ? 0 : 1);
          const verification = readSqliteDatabaseIntegrityVerification(pathname);
          const validation = getOpenClawAgentDatabaseValidationForTransfer(target);
          // Updater backups verify private images; its inline migration checks the live source.
          const verifiedLiveSource = check === "full" && !update;
          if (verifiedLiveSource) {
            expect(verification).toBeDefined();
            expect(validation?.integrityVerifiedAt).toBe(verification?.verifiedAt);
          } else {
            expect(verification).toBeUndefined();
            expect(validation).toBeUndefined();
          }
          expect(liveFullChecks()).toBe(verifiedLiveSource ? 1 : 0);
          await expect(assertDoctorMaintenanceReady(cfg, state.env, () => {})).resolves.toEqual({
            schemaPublicationDeferred: false,
          });
          const reopened = openOpenClawAgentDatabase({ ...target, env: state.env });
          expect(
            reopened.db
              .prepare("SELECT value_json FROM cache_entries WHERE scope = 'retained'")
              .get(),
          ).toEqual({ value_json: '"preserved"' });
          expect(liveFullChecks()).toBe(1);
          expect(readSqliteDatabaseIntegrityVerification(pathname)).toBeDefined();
        });
      } finally {
        vi.restoreAllMocks();
      }
    });
  },
);

it("excludes an older database that is both pending and indeterminate from version receipts", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    openOpenClawStateDatabase({ env: state.env });
    const targets = ["indeterminate"].map((agentId) => ({
      agentId,
      path: state.statePath("agents", agentId, "agent", "openclaw-agent.sqlite"),
    }));
    for (const target of targets) {
      openLegacyDatabase(target.path, 26, target.agentId).close();
    }
    const preflight = await preflightOpenClawDatabaseSchemas({
      env: state.env,
      configuredAgentDatabaseTargets: targets,
      verifyCurrentSchemaShape: true,
    });
    expect(preflight.pendingMigrations).toEqual([
      expect.objectContaining({ path: targets[0]!.path, foundVersion: 26 }),
    ]);
    expect(preflight.indeterminate).toEqual([
      expect.objectContaining({ kind: "agent", path: targets[0]!.path }),
    ]);
    const admitted = targets.filter(
      (target) => !preflight.indeterminate.some((failure) => failure.path === target.path),
    );
    const result = await withMaintenance(() =>
      prepareDoctorDatabaseMigrations({
        env: state.env,
        pendingDatabasePaths: preflight.pendingMigrations!.map((entry) => entry.path),
        pendingMigrations: preflight.pendingMigrations,
        databasePaths: admitted.map((target) => target.path),
        agentDatabaseTargets: admitted.map((target) => ({
          agentId: target.agentId,
          path: target.path,
          realPath: target.path,
          source: "configured" as const,
        })),
      }),
    );
    expect(result.versionMigrations).toEqual([]);
    for (const target of targets) {
      using database = new DatabaseSync(target.path, { readOnly: true });
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(26);
    }
  });
});

it("bounds the version phase and restores a committed member when a later migration fails", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const pathname = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
    using database = openLegacyDatabase(pathname);
    database.exec(`
      INSERT INTO context_engine_turn_outbox
        (rowid, advancement_key, engine_id, session_id, payload_json, created_at)
      VALUES (40, 'z-first', 'test', 'history', '{"state":"ready"}', 1),
             (91, 'a-second', 'test', 'history', '{"state":"blocked"}', 2);
      INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
      VALUES ('agent:main:main', 'history', '{"sessionId":"history","updatedAt":1}', 1);
      INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      VALUES ('history', 'agent:main:main', 1, 1);
      INSERT INTO transcript_events (session_id, seq, event_json, created_at)
      VALUES ('history', 1, '{"type":"message","message":{"role":"user","content":"synthetic retained history"}}', 1);
      INSERT INTO cache_entries (scope, key, value_json, updated_at)
      VALUES ('migration-proof', 'unrelated', '"before"', 1);
      ANALYZE;
    `);
    // Older writers may lack startup additions. The version phase must leave
    // those siblings alone; subsequent same-version admission still repairs them.
    const column = database
      .prepare("PRAGMA table_info(session_nodes)")
      .all()
      .find((entry) => entry.name === "project_id");
    if (column) {
      database.exec("ALTER TABLE session_nodes DROP COLUMN project_id");
    }
    const migration = {
      kind: "agent" as const,
      agentId: "main",
      path: pathname,
      foundVersion: 26,
      supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    };
    const failedMigration = {
      ...migration,
      agentId: "broken",
      path: state.statePath("agents", "broken", "agent", "openclaw-agent.sqlite"),
    };
    {
      using broken = openLegacyDatabase(failedMigration.path, 26, "broken");
      // Valid SQLite, but an unsupported outbox shape makes the real version
      // runner fail after the first member has committed.
      broken.exec(`
        ALTER TABLE context_engine_turn_outbox DROP COLUMN last_error;
      `);
    }
    const migrations = [migration, failedMigration];
    const tables = resolveSchemaMigrationBackupTables(migration)!;
    const originalOutbox = database
      .prepare("SELECT rowid AS enqueue_sequence, * FROM context_engine_turn_outbox ORDER BY rowid")
      .all();
    const outboxSchemaQuery = `SELECT type, name, sql FROM sqlite_schema
      WHERE tbl_name = 'context_engine_turn_outbox' ORDER BY type, name`;
    const originalOutboxSchema = database.prepare(outboxSchemaQuery).all();
    await withMaintenance(async () => {
      await assertSqliteMigrationScopePreserved(database, tables, async () => {
        await expect(
          prepareDoctorDatabaseMigrations(migrationParams(state.env, migrations)),
        ).rejects.toThrow(/context_engine_turn_outbox|last_error/);
      });
    });
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    {
      using broken = new DatabaseSync(failedMigration.path, { readOnly: true });
      expect(broken.prepare("PRAGMA user_version").get()?.user_version).toBe(26);
    }
    expect(
      database.prepare("SELECT * FROM context_engine_turn_outbox ORDER BY enqueue_sequence").all(),
    ).toEqual(originalOutbox);
    const archive = fs
      .readdirSync(path.dirname(pathname))
      .find((name) => name.endsWith(".scoped.bak"));
    expect(archive).toBeDefined();
    const backupPath = path.join(path.dirname(pathname), archive!);
    expect(inspectScopedMigrationSnapshot(backupPath).tables.map((table) => table.name)).toEqual(
      tables,
    );

    // Explicit recovery of the failed group must preserve subsequent writes by
    // unrelated owners while restoring the first member's original outbox.
    database.exec(`UPDATE cache_entries SET value_json = '"later owner write"'
      WHERE scope = 'migration-proof'`);
    await restoreDoctorMigrationBackup({ sourcePath: pathname, backupPath, env: state.env });
    expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(26);
    {
      // Node 24.19 retains stale SELECT * metadata across another handle's table rebuild.
      using restored = new DatabaseSync(pathname, { readOnly: true });
      expect(restored.prepare(outboxSchemaQuery).all()).toEqual(originalOutboxSchema);
      expect(
        restored
          .prepare(
            "SELECT rowid AS enqueue_sequence, * FROM context_engine_turn_outbox ORDER BY rowid",
          )
          .all(),
      ).toEqual(originalOutbox);
    }
    expect(
      database.prepare("SELECT value_json FROM cache_entries WHERE scope = 'migration-proof'").get()
        ?.value_json,
    ).toBe('"later owner write"');

    await withAgentDatabaseMaintenanceLease({ env: state.env }, async () => {
      agentSchema.ensureOpenClawAgentDatabaseSchema(database, {
        agentId: "main",
        path: pathname,
        env: state.env,
      });
      // Re-running at the same version retains the explicit repair contract.
      database.exec("ALTER TABLE session_nodes DROP COLUMN project_id");
      agentSchema.ensureOpenClawAgentDatabaseSchema(database, {
        agentId: "main",
        path: pathname,
        env: state.env,
      });
    });
    expect(database.prepare("PRAGMA table_info(session_nodes)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "project_id" })]),
    );
  });
});

it("preserves orphan history before admitting a group of scoped version migrations", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    openOpenClawStateDatabase({ env: state.env });
    const migrations = ["healthy", "main"].map((agentId) => ({
      kind: "agent" as const,
      agentId,
      path: state.statePath("agents", agentId, "agent", "openclaw-agent.sqlite"),
      foundVersion: 26,
      supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    }));
    for (const migration of migrations) {
      using database = openLegacyDatabase(migration.path, 26, migration.agentId);
      database.exec("PRAGMA foreign_keys = OFF;");
      database.exec(`
        INSERT INTO context_engine_turn_outbox
          (advancement_key, engine_id, session_id, payload_json, created_at)
        VALUES ('pending', 'test', 'retained', '{"state":"ready"}', 1);
        INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
        VALUES ('retained', 'retained', '{"sessionId":"retained","updatedAt":1}', 1),
               ('orphan', 'orphan', '{"sessionId":"orphan","updatedAt":1}', 1);
        INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
        VALUES ('retained', 'retained', 1, 1), ('orphan', 'orphan', 1, 1);
        INSERT INTO transcript_events (session_id, seq, event_json, created_at)
        VALUES ('retained', 1, '{"type":"message","message":{"role":"user","content":"keep"}}', 1),
               ('orphan', 1, '{"type":"message","message":{"role":"user","content":"preserve in recovery"}}', 1);
      `);
      if (migration.agentId === "main") {
        database.exec("DELETE FROM session_nodes WHERE session_key = 'orphan'");
      }
    }
    const damagedPath = migrations[1]!.path;
    const readHistory = (database: DatabaseSync) => ({
      windows: database.prepare("SELECT * FROM session_windows ORDER BY session_id").all(),
      events: database.prepare("SELECT * FROM transcript_events ORDER BY session_id, seq").all(),
    });
    let original: ReturnType<typeof readHistory>;
    {
      using database = new DatabaseSync(damagedPath, { readOnly: true });
      original = readHistory(database);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toHaveLength(1);
    }
    await withMaintenance(async () => {
      const result = await prepareDoctorDatabaseMigrations(migrationParams(state.env, migrations));
      expect(result.warnings).toEqual([]);
      expect(result.changes).toContain(
        `Removed 1 orphan session window(s) from ${damagedPath}; their dependent history remains in the backup.`,
      );
    });
    for (const migration of migrations) {
      using database = new DatabaseSync(migration.path, { readOnly: true });
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(fs.readdirSync(path.dirname(migration.path))).toEqual(
        expect.arrayContaining([expect.stringMatching(/\.scoped\.bak$/)]),
      );
    }
    {
      using database = new DatabaseSync(damagedPath, { readOnly: true });
      const retained = readHistory(database);
      expect(retained.windows).toEqual(
        original.windows.filter((row) => row.session_id === "retained"),
      );
      expect(retained.events).toEqual(
        original.events.filter((row) => row.session_id === "retained"),
      );
    }
    const backups = fs
      .readdirSync(path.dirname(damagedPath))
      .filter((name) => name.startsWith("openclaw-session-window-recovery-"));
    expect(backups).toHaveLength(1);
    using backup = new DatabaseSync(
      path.join(path.dirname(damagedPath), backups[0]!, "database.sqlite"),
      { readOnly: true },
    );
    expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(26);
    expect(readHistory(backup)).toEqual(original);
  });
});
