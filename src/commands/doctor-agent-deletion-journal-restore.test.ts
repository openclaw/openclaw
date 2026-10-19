import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

async function withFixture(
  run: (fixture: {
    env: NodeJS.ProcessEnv;
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
    await run({ env, agentPath, sharedPath });
  });
}

async function repair(env: NodeJS.ProcessEnv) {
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: () => {},
  });
  try {
    return await maintenance.run(async () =>
      repairDoctorAgentDeletionJournal({
        preflight: await prepareDoctorDatabasePreflight(),
        shouldRepair: true,
        env,
      }),
    );
  } finally {
    await maintenance.close();
  }
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
  async (agentId) => {
    await withFixture(async ({ env, agentPath, sharedPath }) => {
      const ordinaryPath = path.join(
        env.OPENCLAW_STATE_DIR!,
        "agents/main/agent/openclaw-agent.sqlite",
      );
      fs.mkdirSync(path.dirname(ordinaryPath), { recursive: true });
      fs.copyFileSync(agentPath, ordinaryPath);
      using ordinary = new DatabaseSync(ordinaryPath);
      ordinary.exec("UPDATE schema_meta SET agent_id = 'main'");
      ordinary.close();
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
      expect(readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env }))).toEqual([held[1]]);
      const backups = result.changes
        .filter((change) => change.startsWith("Saved pre-migration SQLite backup: "))
        .map((change) => change.slice("Saved pre-migration SQLite backup: ".length));
      expect(backups).toHaveLength(2);
      for (const backup of backups) {
        using database = new DatabaseSync(backup, { readOnly: true });
        expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        if (backup.startsWith(agentPath)) {
          expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(24);
          expect(
            database.prepare("SELECT value_json FROM cache_entries WHERE key = 'preserved'").get()
              ?.value_json,
          ).toBe('{"bytes":"preserved 🦞"}');
        } else {
          expect(backup.startsWith(sharedPath)).toBe(true);
          const report = database
            .prepare("SELECT report_json FROM migration_sources WHERE source_key = ?")
            .get(AGENT_DELETION_RECOVERY_SOURCE_KEY)?.report_json;
          expect(JSON.parse(String(report)).held).toHaveLength(2);
          expect(
            database
              .prepare("SELECT report_json FROM migration_runs WHERE id = 'published-quarantine'")
              .get()?.report_json,
          ).toBe(report);
        }
      }

      const maintenance = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: () => {},
      });
      try {
        await maintenance.run(async () => {
          const next = await prepareDoctorDatabasePreflight();
          expect(next.pendingMigrations).toContainEqual(
            expect.objectContaining({ path: agentPath, foundVersion: 24 }),
          );
          await migrateLegacyMediaPersistence({
            env,
            preparedDiscovery: next.agentDatabaseMigrationDiscovery,
          });
        });
      } finally {
        await maintenance.close();
      }
      using migrated = new DatabaseSync(agentPath, { readOnly: true });
      expect(migrated.prepare("PRAGMA user_version").get()?.user_version).toBe(
        OPENCLAW_AGENT_SCHEMA_VERSION,
      );
      expect(
        migrated.prepare("SELECT value_json FROM cache_entries WHERE key = 'preserved'").get()
          ?.value_json,
      ).toBe('{"bytes":"preserved 🦞"}');
      migrated.close();
      expect(fs.readFileSync(ordinaryPath)).toEqual(ordinaryBytes);
      expect((await repair(env)).changes).toEqual([]);
      expect(readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env }))).toEqual([held[1]]);
    }, agentId);
  },
);

it.each(["different-agent", "noncanonical-path"])(
  "keeps a reserved hold without verified ownership (%s)",
  async (kind) => {
    await withFixture(async ({ env, agentPath }) => {
      let pathname = agentPath;
      if (kind === "different-agent") {
        using database = new DatabaseSync(pathname);
        database.exec("UPDATE schema_meta SET agent_id = 'main'");
      } else {
        pathname = path.join(path.dirname(agentPath), "history.sqlite");
        fs.renameSync(agentPath, pathname);
      }
      const held = [{ agentId: "openclaw", path: pathname }];
      seedLegacyQuarantineHolds(env, held);
      const bytes = fs.readFileSync(pathname);
      const maintenance = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: () => {},
      });
      try {
        expect(
          await maintenance.run(() => restoreDoctorMissingJournalStores({ env, held })),
        ).toEqual({ changes: [], warnings: [], restored: [] });
      } finally {
        await maintenance.close();
      }
      expect(readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env }))).toEqual(held);
      expect(fs.readFileSync(pathname)).toEqual(bytes);
    }, "openclaw");
  },
);

it.each(["first-upgrade", "already-held"])(
  "restores a populated published store with verified backups on %s",
  async (phase) => {
    await withFixture(async ({ env, agentPath, sharedPath }) => {
      using shared = new DatabaseSync(sharedPath);
      shared.exec("DROP TABLE agent_deletion_journal");
      shared.close();
      const agentPaths = [agentPath];
      if (phase === "first-upgrade") {
        const otherPath = path.join(
          env.OPENCLAW_STATE_DIR!,
          "agents/ops/agent/openclaw-agent.sqlite",
        );
        fs.mkdirSync(path.dirname(otherPath), { recursive: true });
        fs.copyFileSync(agentPath, otherPath);
        using other = new DatabaseSync(otherPath);
        other.exec("UPDATE schema_meta SET agent_id = 'ops'");
        other.close();
        const config = JSON.parse(fs.readFileSync(env.OPENCLAW_CONFIG_PATH!, "utf8"));
        config.agents.ownership = "explicit";
        config.agents.entries.ops = {
          workspace: path.join(env.OPENCLAW_STATE_DIR!, "workspace-ops"),
        };
        fs.writeFileSync(env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
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
        const row = state.db
          .prepare(
            "SELECT report_json FROM migration_sources WHERE source_key = 'agent-deletion-journal-reconstruction'",
          )
          .get();
        const report = JSON.parse(String(row?.report_json));
        delete report.missingJournal;
        state.db
          .prepare(
            "UPDATE migration_sources SET report_json = ? WHERE source_key = 'agent-deletion-journal-reconstruction'",
          )
          .run(JSON.stringify(report));
      }
      const result = await repair(env);
      expect(result.warnings.join("\n")).toContain("Automatically restored agent main");
      expect(result.warnings.join("\n")).toContain("Verified backup:");
      if (phase === "first-upgrade") {
        expect(result.warnings.join("\n")).toContain("Automatically restored agent ops");
      }
      expect(readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env }))).toEqual([]);
      expect(agentPaths.map((pathname) => fs.readFileSync(pathname))).toEqual(bytes);
      const backups = result.changes
        .filter((change) => change.startsWith("Saved pre-migration SQLite backup: "))
        .map((change) => change.slice("Saved pre-migration SQLite backup: ".length));
      expect(backups).toHaveLength(agentPaths.length + 1);
      for (const backup of backups) {
        using database = new DatabaseSync(backup, { readOnly: true });
        expect(database.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
        if (agentPaths.some((pathname) => backup.startsWith(pathname))) {
          expect(
            database.prepare("SELECT value_json FROM cache_entries WHERE key='preserved'").get()
              ?.value_json,
          ).toBe('{"bytes":"preserved 🦞"}');
        } else {
          expect(
            database
              .prepare(
                "SELECT report_json FROM migration_sources WHERE source_key = 'agent-deletion-journal-reconstruction'",
              )
              .get()?.report_json,
          ).toContain('"agentId":"main"');
          expect(
            database.prepare("SELECT count(*) AS n FROM migration_runs").get()?.n,
          ).toBeGreaterThan(0);
        }
      }
      expect(await repair(env)).toEqual({ changes: [], warnings: [] });
    });
  },
);

it.each(["present-incomplete", "other-version", "rewritten-stamp"])(
  "keeps %s stores held",
  async (kind) => {
    await withFixture(async ({ env, agentPath, sharedPath }) => {
      using shared = new DatabaseSync(sharedPath);
      if (kind === "present-incomplete") {
        beginAgentDeletionJournal(
          {
            agentId: "main",
            operationId: "lost-history",
            agentDir: path.dirname(agentPath),
            workspaceDir: path.join(env.OPENCLAW_STATE_DIR!, "workspace"),
            sessionsDir: path.join(env.OPENCLAW_STATE_DIR!, "agents/main/sessions"),
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
      expect(readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env }))).toContainEqual({
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
    });
  },
);

it.each(["root", "included"])(
  "does not restore after the %s config removes an agent during backup",
  async (source) => {
    await withFixture(async ({ env, agentPath, sharedPath }) => {
      using shared = new DatabaseSync(sharedPath);
      shared.exec("DROP TABLE agent_deletion_journal");
      shared.close();
      const configPath = env.OPENCLAW_CONFIG_PATH!;
      const originalConfig = fs.readFileSync(configPath, "utf8");
      const changedPath =
        source === "root" ? configPath : path.join(env.OPENCLAW_STATE_DIR!, "roster.json");
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
        expect(fs.existsSync(path.join(env.OPENCLAW_STATE_DIR!, "workspace"))).toBe(false);
        expect(fs.readFileSync(agentPath)).toEqual(bytes);
        expect(readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env }))).toContainEqual({
          agentId: "main",
          path: agentPath,
        });
      } finally {
        mutation.mockRestore();
      }
    });
  },
);
