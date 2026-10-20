import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { recordLegacyMigrationReceipt } from "../infra/state-migrations.receipts.js";
import {
  AGENT_DELETION_RECOVERY_SOURCE_KEY,
  readAgentDeletionRecoveryHolds,
} from "../state/agent-deletion-journal-recovery.kernel.js";
import type { HeldAgentDatabase } from "../state/agent-deletion-journal.types.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { withEnvAsync } from "../test-utils/env.js";
import { restoreDoctorMissingJournalStores } from "./doctor-agent-deletion-journal-restore.js";
import { repairDoctorAgentDeletionJournal } from "./doctor-agent-deletion-journal.js";
import { prepareDoctorDatabasePreflight } from "./doctor-database-preflight.js";
import * as migrationBackup from "./doctor-migration-backup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
const row = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).get(...params);
const sourceReport = (db: DatabaseSync, key: string) =>
  row(db, "SELECT report_json FROM migration_sources WHERE source_key = ?", key)?.report_json;
const reconstructionKey = "agent-deletion-journal-reconstruction";

function exec(pathname: string, sql: string) {
  using database = new DatabaseSync(pathname);
  database.exec(sql);
}

async function withFixture(
  run: (fixture: {
    env: NodeJS.ProcessEnv;
    root: string;
    configPath: string;
    agentPath: string;
    sharedPath: string;
  }) => Promise<void>,
  agentId = "main",
) {
  const root = fs.realpathSync.native(dirs.make("doctor-published-journal-"));
  const env = {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_HOME: root,
    OPENCLAW_AGENT_DIR: undefined,
    PI_CODING_AGENT_DIR: undefined,
  };
  await withEnvAsync(env, async () => {
    fs.writeFileSync(
      env.OPENCLAW_CONFIG_PATH,
      JSON.stringify({
        agents: { entries: { main: { workspace: path.join(root, "workspace") } } },
        plugins: { enabled: false },
      }),
    );
    const sharedPath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const agentPath = path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(agentPath), { recursive: true });
    using agent = new DatabaseSync(agentPath);
    agent.exec(
      fs.readFileSync(
        new URL("../../test/fixtures/sqlite/openclaw-agent-schema-v24.sql", import.meta.url),
        "utf8",
      ),
    );
    agent.exec("PRAGMA user_version = 24");
    agent
      .prepare(
        "INSERT INTO schema_meta VALUES ('primary', 'agent', 24, ?, '2026.10.4', 1000, 1000)",
      )
      .run(agentId);
    agent
      .prepare(
        "INSERT INTO cache_entries(scope, key, value_json, updated_at) VALUES ('user', 'preserved', ?, 1000)",
      )
      .run('{"bytes":"preserved 🦞"}');
    agent.close();
    await run({ env, agentPath, sharedPath, root, configPath: env.OPENCLAW_CONFIG_PATH });
  });
}

async function withMaintenance<T>(run: () => Promise<T>) {
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: () => {},
  });
  try {
    return await maintenance.run(run);
  } finally {
    await maintenance.close();
  }
}

const repair = (env: NodeJS.ProcessEnv) =>
  withMaintenance(async () =>
    repairDoctorAgentDeletionJournal({
      preflight: await prepareDoctorDatabasePreflight(),
      shouldRepair: true,
      env,
    }),
  );
const recoveryHolds = (env: NodeJS.ProcessEnv) =>
  readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env }));
const backupPaths = (changes: string[]) =>
  changes
    .filter((change) => change.startsWith("Saved pre-migration SQLite backup: "))
    .map((change) => change.slice("Saved pre-migration SQLite backup: ".length));
const preservedBytes = '{"bytes":"preserved 🦞"}';
const preservedValue = (database: DatabaseSync) =>
  row(database, "SELECT value_json FROM cache_entries WHERE key = 'preserved'")?.value_json;

function verifyBackups(
  changes: string[],
  agentPaths: string[],
  inspectShared: (database: DatabaseSync, pathname: string) => void,
  inspectAgent: (database: DatabaseSync) => void = () => {},
) {
  const backups = backupPaths(changes);
  expect(backups).toHaveLength(agentPaths.length + 1);
  for (const backup of backups) {
    using database = new DatabaseSync(backup, { readOnly: true });
    expect(row(database, "PRAGMA integrity_check")?.integrity_check).toBe("ok");
    if (agentPaths.some((pathname) => backup.startsWith(pathname))) {
      expect(preservedValue(database)).toBe(preservedBytes);
      inspectAgent(database);
    } else {
      inspectShared(database, backup);
    }
  }
}

function copyAgent(source: string, target: string, agentId: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  using database = new DatabaseSync(target);
  database.prepare("UPDATE schema_meta SET agent_id = ?").run(agentId);
}

function seedLegacyQuarantineHolds(env: NodeJS.ProcessEnv, held: HeldAgentDatabase[]) {
  // The shipped Doctor could hold reserved stores; the fixed producer must never do so.
  runOpenClawStateWriteTransaction(
    (database) =>
      recordLegacyMigrationReceipt(database.db, {
        sourceKey: AGENT_DELETION_RECOVERY_SOURCE_KEY,
        migrationKind: AGENT_DELETION_RECOVERY_SOURCE_KEY,
        sourcePath: database.path,
        targetTable: "agent_deletion_journal",
        sourceSha256: null,
        sourceSizeBytes: null,
        sourceRecordCount: null,
        runId: "published-quarantine",
        now: 1000,
        reportJson: JSON.stringify({
          description:
            "Quarantined unusable agent deletion records; stores remain held for explicit recovery.",
          held: held.map((target) => ({
            agentId: target.agentId,
            path: path.relative(env.OPENCLAW_STATE_DIR!, target.path),
          })),
        }),
      }),
    { env },
  );
}

it.each(["openclaw", "crestodian"])(
  "restores and migrates held schema-24 %s while preserving ordinary holds and rollback images",
  (agentId) =>
    withFixture(async ({ env, agentPath, sharedPath, root }) => {
      const ordinaryPath = path.join(root, "agents/main/agent/openclaw-agent.sqlite");
      copyAgent(agentPath, ordinaryPath, "main");
      const ordinaryBytes = fs.readFileSync(ordinaryPath);
      const held = [
        { agentId, path: agentPath },
        { agentId: "main", path: ordinaryPath },
      ];
      seedLegacyQuarantineHolds(env, held);
      const initial = await prepareDoctorDatabasePreflight();
      expect(initial.pendingMigrations?.some((entry) => entry.path === agentPath)).not.toBe(true);

      const result = await repair(env);
      expect(result.warnings.join("\n")).toContain(`Automatically restored agent ${agentId}`);
      expect(recoveryHolds(env)).toEqual([held[1]]);
      verifyBackups(
        result.changes,
        [agentPath],
        (database, backup) => {
          expect(backup.startsWith(sharedPath)).toBe(true);
          const report = sourceReport(database, AGENT_DELETION_RECOVERY_SOURCE_KEY);
          expect(JSON.parse(String(report)).held).toHaveLength(2);
          expect(
            row(
              database,
              "SELECT report_json FROM migration_runs WHERE id = 'published-quarantine'",
            )?.report_json,
          ).toBe(report);
        },
        (database) => expect(row(database, "PRAGMA user_version")?.user_version).toBe(24),
      );

      await withMaintenance(async () => {
        const next = await prepareDoctorDatabasePreflight();
        expect(next.pendingMigrations).toContainEqual(
          expect.objectContaining({ path: agentPath, foundVersion: 24 }),
        );
        await migrateLegacyMediaPersistence({
          env,
          preparedDiscovery: next.agentDatabaseMigrationDiscovery,
        });
      });
      using migrated = new DatabaseSync(agentPath, { readOnly: true });
      expect(row(migrated, "PRAGMA user_version")?.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      expect(preservedValue(migrated)).toBe(preservedBytes);
      migrated.close();
      expect(fs.readFileSync(ordinaryPath)).toEqual(ordinaryBytes);
      expect((await repair(env)).changes).toEqual([]);
      expect(recoveryHolds(env)).toEqual([held[1]]);
    }, agentId),
);

it.each(["different-agent", "noncanonical-path"])(
  "keeps a reserved hold without verified ownership (%s)",
  (kind) =>
    withFixture(async ({ env, agentPath }) => {
      let pathname = agentPath;
      if (kind === "different-agent") {
        exec(pathname, "UPDATE schema_meta SET agent_id = 'main'");
      } else {
        pathname = path.join(path.dirname(agentPath), "history.sqlite");
        fs.renameSync(agentPath, pathname);
      }
      const held = [{ agentId: "openclaw", path: pathname }];
      seedLegacyQuarantineHolds(env, held);
      const bytes = fs.readFileSync(pathname);
      expect(await withMaintenance(() => restoreDoctorMissingJournalStores({ env, held }))).toEqual(
        { changes: [], warnings: [], restored: [] },
      );
      expect(recoveryHolds(env)).toEqual(held);
      expect(fs.readFileSync(pathname)).toEqual(bytes);
    }, "openclaw"),
);

it.each(["first-upgrade", "already-held"])(
  "restores a populated published store with verified backups on %s",
  (phase) =>
    withFixture(async ({ env, agentPath, sharedPath, root, configPath }) => {
      exec(sharedPath, "DROP TABLE agent_deletion_journal");
      const agentPaths = [agentPath];
      if (phase === "first-upgrade") {
        const otherPath = path.join(root, "agents/ops/agent/openclaw-agent.sqlite");
        copyAgent(agentPath, otherPath, "ops");
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        config.agents.ownership = "explicit";
        config.agents.entries.ops = {
          workspace: path.join(root, "workspace-ops"),
        };
        fs.writeFileSync(configPath, JSON.stringify(config));
        agentPaths.push(otherPath);
        const preview = await repairDoctorAgentDeletionJournal({
          preflight: await prepareDoctorDatabasePreflight(),
          shouldRepair: false,
          env,
        });
        expect(preview.warnings.join("\n")).toContain("automatically after verified backups");
        expect(preview.warnings.join("\n")).not.toContain("without activating held stores");
      }
      const bytes = agentPaths.map((pathname) => fs.readFileSync(pathname));
      if (phase === "already-held") {
        // The old Doctor owner produces a real reconstruction receipt; remove only
        // the new optional observation field to exercise the published format.
        await repairDoctorAgentDeletionJournal({
          preflight: await prepareDoctorDatabasePreflight(),
          shouldRepair: true,
          env,
        });
        const state = openOpenClawStateDatabase({ env });
        const report = JSON.parse(String(sourceReport(state.db, reconstructionKey)));
        delete report.missingJournal;
        state.db
          .prepare("UPDATE migration_sources SET report_json = ? WHERE source_key = ?")
          .run(JSON.stringify(report), reconstructionKey);
      }
      const result = await repair(env);
      expect(result.warnings.join("\n")).toContain("Automatically restored agent main");
      expect(result.warnings.join("\n")).toContain("Verified backup:");
      if (phase === "first-upgrade") {
        expect(result.warnings.join("\n")).toContain("Automatically restored agent ops");
      }
      expect(recoveryHolds(env)).toEqual([]);
      expect(agentPaths.map((pathname) => fs.readFileSync(pathname))).toEqual(bytes);
      verifyBackups(result.changes, agentPaths, (database) => {
        expect(sourceReport(database, reconstructionKey)).toContain('"agentId":"main"');
        expect(row(database, "SELECT count(*) AS n FROM migration_runs")?.n).toBeGreaterThan(0);
      });
      expect(await repair(env)).toEqual({ changes: [], warnings: [] });
    }),
);

it.each(["present-incomplete", "other-version", "rewritten-stamp"])(
  "keeps %s stores held",
  (kind) =>
    withFixture(async ({ env, agentPath, sharedPath, root }) => {
      using shared = new DatabaseSync(sharedPath);
      if (kind === "present-incomplete") {
        beginAgentDeletionJournal(
          {
            agentId: "main",
            operationId: "lost-history",
            agentDir: path.dirname(agentPath),
            workspaceDir: path.join(root, "workspace"),
            sessionsDir: path.join(root, "agents/main/sessions"),
            databasePaths: [agentPath],
            deleteFiles: false,
          },
          { env },
        );
        shared.exec(
          "UPDATE agent_deletion_journal SET database_paths_json = '[' WHERE agent_id = 'main'",
        );
      } else {
        shared.exec("DROP TABLE agent_deletion_journal");
      }
      shared.close();
      if (kind !== "present-incomplete") {
        using agent = new DatabaseSync(agentPath);
        agent.exec(
          kind === "other-version"
            ? "UPDATE schema_meta SET app_version = '2026.9.6'"
            : "UPDATE schema_meta SET updated_at = 2000",
        );
      }
      const bytes = fs.readFileSync(agentPath);
      const result = await repair(env);
      expect(result.warnings.join("\n")).not.toContain("Automatically restored");
      expect(result.warnings.join("\n")).toContain("held back");
      expect(result.warnings.join("\n")).toContain("agents add");
      expect(recoveryHolds(env)).toContainEqual({
        agentId: "main",
        path: agentPath,
      });
      expect(fs.readFileSync(agentPath)).toEqual(bytes);
      await expect(
        assertOpenClawDatabasesReady({
          env,
          operation: "doctor",
          config: { agents: { entries: { main: {} } } },
          configuredAgentDatabaseTargets: [{ agentId: "main", path: agentPath }],
        }),
      ).rejects.toThrow("Doctor could not complete repair");
    }),
);

it.each(["root", "included"])(
  "does not restore after the %s config removes an agent during backup",
  (source) =>
    withFixture(async ({ env, agentPath, sharedPath, root, configPath }) => {
      exec(sharedPath, "DROP TABLE agent_deletion_journal");
      const originalConfig = fs.readFileSync(configPath, "utf8");
      const changedPath = source === "root" ? configPath : path.join(root, "roster.json");
      if (source === "included") {
        fs.writeFileSync(changedPath, originalConfig);
        fs.writeFileSync(configPath, JSON.stringify({ $include: "./roster.json" }));
      }
      const newerConfig = JSON.stringify({
        agents: { entries: { ops: {} } },
        plugins: { enabled: false },
      });
      const bytes = fs.readFileSync(agentPath);
      const backup = migrationBackup.backupDoctorSqliteDatabases;
      const mutation = vi
        .spyOn(migrationBackup, "backupDoctorSqliteDatabases")
        .mockImplementationOnce(async (params) => {
          const result = await backup(params);
          fs.writeFileSync(changedPath, newerConfig);
          return result;
        });
      try {
        await expect(repair(env)).rejects.toThrow("config changed before");
        expect(mutation).toHaveBeenCalledOnce();
        expect(fs.readFileSync(changedPath, "utf8")).toBe(newerConfig);
        expect(fs.existsSync(path.join(root, "workspace"))).toBe(false);
        expect(fs.readFileSync(agentPath)).toEqual(bytes);
        expect(recoveryHolds(env)).toContainEqual({
          agentId: "main",
          path: agentPath,
        });
      } finally {
        mutation.mockRestore();
      }
    }),
);
