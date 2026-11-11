import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { verifyBackupArchive } from "../commands/backup-verify.js";
import { createDatabaseMigrationFilesystemBackup } from "../commands/database-migration-filesystem-backup.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { expectDatabaseRows } from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { preparePostgresBackupDiscovery } from "./backup-database-discovery.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { createUpdateDatabaseBackup } from "./update-database-backup.js";
import { assertUpdateDatabaseEngineContexts } from "./update-database-engine-admission.js";

// Exercise the real process deadline, without sleeps or a mocked discovery owner.
// One millisecond cannot start the Node header worker and return its inventory.
it("applies the configured header deadline to update admission and database capture", async () => {
  await withOpenClawTestState({ layout: "home", scenario: "minimal" }, async (state) => {
    const pluginRoot = state.path("plugin");
    await fs.mkdir(pluginRoot);
    createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: "retained-owner",
      manifest: {
        backupResources: [
          {
            disposition: "include",
            scope: "state",
            relativePath: "retained",
            databaseFamily: "state",
          },
        ],
      },
    });
    await fs.mkdir(state.statePath("retained"));
    const databasePath = state.statePath("retained", "history.db");
    {
      using database = openNodeSqliteDatabase(databasePath);
      database.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('retained')");
    }
    const input = {
      stateDir: state.stateDir,
      env: state.env,
      config: {
        update: { sqliteHeaderProbeTimeoutMs: 1 },
        plugins: { enabled: false, load: { paths: [pluginRoot] } },
      },
    };
    await expect(assertUpdateDatabaseEngineContexts([input], ["sqlite"])).rejects.toThrow(
      /SQLite header probe timed out after 1 ms/,
    );
    await expect(
      createUpdateDatabaseBackup({ ...input, backupRoot: state.path("capture"), stopped: true }),
    ).rejects.toThrow(/SQLite header probe timed out after 1 ms/);
    // The metadata worker also runs with SQLite inputs; no PostgreSQL server is needed.
    await expect(
      preparePostgresBackupDiscovery({ ...input, sqliteHeaderProbeTimeoutMs: 1 }),
    ).rejects.toThrow(/SQLite header probe timed out after 1 ms/);
    await expect(fs.stat(state.path("capture.databases"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    input.config.update.sqliteHeaderProbeTimeoutMs = 120_000;
    await expect(assertUpdateDatabaseEngineContexts([input], ["sqlite"])).resolves.toBeUndefined();
    const captured = await createUpdateDatabaseBackup({
      ...input,
      backupRoot: state.path("capture"),
      stopped: true,
    });
    expect(captured.databases).toHaveLength(1);
    expect(captured.databases[0]?.path).toBe(databasePath);
    expectDatabaseRows(captured.databases[0]!.snapshotPath, "SELECT value FROM evidence", [
      { value: "retained" },
    ]);
  });
});

it("carries the config into the migration archive child without changing standalone backups", async () => {
  await withOpenClawTestState({ layout: "home", scenario: "minimal" }, async (state) => {
    const source = state.statePath("retained.txt");
    await fs.writeFile(source, "retained operator data");
    const config = { update: { sqliteHeaderProbeTimeoutMs: 1 } };
    await state.writeConfig(config);
    const output = state.path("migration.tar.gz");
    const input = {
      output,
      stateDir: state.stateDir,
      config,
      env: state.env,
      signal: new AbortController().signal,
    };
    await expect(createDatabaseMigrationFilesystemBackup(input)).rejects.toThrow(
      /SQLite header probe timed out after 1 ms/,
    );
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(source, "utf8")).toBe("retained operator data");
    const standalone = await createBackupArchive({
      output: state.path("standalone.tar.gz"),
      includeWorkspace: false,
    });
    await verifyBackupArchive(standalone.archivePath);
    config.update.sqliteHeaderProbeTimeoutMs = 120_000;
    await state.writeConfig(config);
    await createDatabaseMigrationFilesystemBackup(input);
    await verifyBackupArchive(output);
    expect(await fs.readFile(source, "utf8")).toBe("retained operator data");
  });
});
