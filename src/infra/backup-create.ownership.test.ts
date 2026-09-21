import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import { buildBackupArchivePath } from "../commands/backup-shared.js";
import { backupCreateCommand } from "../commands/backup.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { inspectOpenClawRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resolveQuarantineStorePath } from "../state/openclaw-quarantine-store.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import * as sqliteSnapshot from "./sqlite-snapshot.js";

describe("backup SQLite ownership", () => {
  it.skipIf(process.platform === "win32")(
    "refuses a declared plugin database hidden behind a symlink",
    async () => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "backup-plugin-symlink-", scenario: "minimal" },
        async (state) => {
          const pluginRoot = state.path("backup-plugin");
          await fs.mkdir(pluginRoot);
          const fixture = createColdPluginFixture({
            rootDir: pluginRoot,
            pluginId: "backup-owner",
            manifest: {
              backupResources: [
                { disposition: "include", scope: "state", relativePath: "plugins/linked.sqlite" },
              ],
            },
          });
          await state.writeConfig(createColdPluginConfig(pluginRoot, fixture.pluginId));
          const linkedPath = state.statePath("plugins", "linked.sqlite");
          const backingPath = state.statePath("plugins", "database.bin");
          await fs.mkdir(path.dirname(backingPath));
          const sqlite = requireNodeSqlite();
          const database = new sqlite.DatabaseSync(backingPath);
          try {
            database.function(
              "plugin_double",
              { deterministic: true },
              (value) => Number(value) * 2,
            );
            database.exec(`
            CREATE TABLE records (value INTEGER NOT NULL);
            INSERT INTO records VALUES (7);
            CREATE INDEX records_double ON records(plugin_double(value));
          `);
          } finally {
            database.close();
          }
          await fs.symlink("database.bin", linkedPath);
          const sourceBytes = await fs.readFile(backingPath);
          const output = state.path("rejected.tar.gz");

          await expect(
            backupCreateCommand(createTestRuntime(), { output, includeWorkspace: false }),
          ).rejects.toThrow(/SQLite backup source identity changed.*linked\.sqlite/iu);
          await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await fs.readFile(backingPath)).toEqual(sourceBytes);
        },
      );
    },
  );

  it("restores an agent registered immediately before the root snapshot with its registry row", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "backup-late-agent-owner-", scenario: "minimal" },
      async (state) => {
        const agentPath = state.path("external-agent", "openclaw-agent.sqlite");
        const registration = { agentId: "main", path: agentPath, env: state.env };
        const agent = openOpenClawAgentDatabase(registration);
        agent.db.exec(`
          CREATE TABLE durable_records (value TEXT NOT NULL);
          INSERT INTO durable_records VALUES ('registered-before-root-capture');
        `);
        closeOpenClawAgentDatabasesForTest();
        unregisterOpenClawAgentDatabase(registration);
        closeOpenClawStateDatabase();
        expect(await inspectOpenClawRegisteredAgentDatabases({ env: state.env })).toEqual([]);
        const globalPath = resolveOpenClawStateSqlitePath(state.env);
        const output = state.path("registered-agent.tar.gz");
        const capture = sqliteSnapshot.createVerifiedSqliteSnapshot;
        let registered = false;
        const snapshot = vi
          .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
          .mockImplementation(async (options) => {
            if (!registered && options.sourcePath === globalPath) {
              registerOpenClawAgentDatabase(registration);
              closeOpenClawStateDatabase();
              registered = true;
            }
            return await capture(options);
          });
        try {
          const runtime = createTestRuntime();
          const onSqliteSnapshots = vi.fn();
          const archive = await backupCreateCommand(runtime, {
            output,
            includeWorkspace: false,
            verify: true,
            onSqliteSnapshots,
          });
          expect(onSqliteSnapshots).toHaveBeenCalledExactlyOnceWith([
            expect.objectContaining({ role: "global", sourcePath: globalPath }),
            expect.objectContaining({ role: "agent", agentId: "main", sourcePath: agentPath }),
          ]);
          expect(registered).toBe(true);
          expect(archive.verified).toBe(true);
          expect(archive.warnings ?? []).toEqual([]);
          const restored = await backupRestoreCommand(runtime, {
            archive: archive.archivePath,
            target: state.path("restored"),
          });
          const sqlite = requireNodeSqlite();
          const restoredGlobal = new sqlite.DatabaseSync(
            path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, globalPath)),
            { readOnly: true },
          );
          try {
            expect(
              restoredGlobal.prepare("SELECT agent_id, path FROM agent_databases").all(),
            ).toEqual([{ agent_id: "main", path: agentPath }]);
          } finally {
            restoredGlobal.close();
          }
          const restoredAgent = new sqlite.DatabaseSync(
            path.join(restored.targetPath, buildBackupArchivePath(archive.archiveRoot, agentPath)),
            { readOnly: true },
          );
          try {
            expect(
              restoredAgent
                .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
                .get(),
            ).toEqual({ role: "agent", agent_id: "main" });
            expect(restoredAgent.prepare("SELECT value FROM durable_records").all()).toEqual([
              { value: "registered-before-root-capture" },
            ]);
          } finally {
            restoredAgent.close();
          }
          const restoredQuarantine = new sqlite.DatabaseSync(
            path.join(
              restored.targetPath,
              buildBackupArchivePath(archive.archiveRoot, resolveQuarantineStorePath(state.env)),
            ),
            { readOnly: true },
          );
          try {
            expect(
              restoredQuarantine.prepare("SELECT path FROM agent_integrity_verifications").all(),
            ).toEqual([{ path: await fs.realpath(agentPath) }]);
          } finally {
            restoredQuarantine.close();
          }
        } finally {
          snapshot.mockRestore();
        }
      },
    );
  });
});
