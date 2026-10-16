import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getEnvironmentData } from "node:worker_threads";
import { Client } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawStateStartupMigrationCheckpointDatabase } from "../state/openclaw-state-db.js";
import {
  getDatabaseEngineSelection,
  installDatabaseEngineSelection,
} from "./database-engine/context.js";
import { resetDatabaseEngineSelectionForTest } from "./database-engine/context.test-support.js";
import { loadDescriptor } from "./database-engine/workboard-port-descriptor.js";
import { acquireGatewayStateOwner } from "./gateway-state-owner.js";
import { createUpdateDatabaseBackup } from "./update-database-backup.js";

// mock-isolation: Only the parent's replaced cold import is unavailable; retained workers run real code.
vi.mock("./backup-sqlite-snapshot.js", () => {
  throw new Error("Installed backup module was replaced");
});

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(!connection).each(["postgres", "sqlite"] as const)(
  "captures service PostgreSQL metadata when the updater selected %s",
  async (callerEngine) => {
    const root = dirs.make("update-backup-shared-postgres-");
    const stateDir = path.join(root, "state");
    const shared = path.join(stateDir, "state/openclaw.sqlite");
    const plugin = path.join(stateDir, "plugins/workboard/workboard.sqlite");
    const workboard = fileURLToPath(new URL("../../extensions/workboard", import.meta.url));
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_TEST_PG_BACKUP_CONNECTION: connection!,
    };
    const input = { connection: connection!, schemaPrefix: "update_backup_test" };
    resetDatabaseEngineSelectionForTest();
    installDatabaseEngineSelection({ input });
    const client = new Client({ connectionString: connection });
    await client.connect();
    const namespaces: string[] = [];
    let owner: ReturnType<typeof acquireGatewayStateOwner> | undefined;
    let maintenance: ReturnType<typeof createOpenClawDatabaseMaintenanceScope> | undefined;
    try {
      withOpenClawStateStartupMigrationCheckpointDatabase(() => {}, { path: shared, env });
      await closeOpenClawStateDatabaseByPathAsync(shared);
      const descriptor = await loadDescriptor();
      if (!descriptor.admit) {
        throw new Error("Workboard fixture requires its database admission owner");
      }
      await descriptor.admit(plugin, input);
      for (const file of [shared, plugin]) {
        using anchor = new DatabaseSync(file, { readOnly: true });
        const namespace = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get()?.schema;
        expect(typeof namespace).toBe("string");
        namespaces.push(String(namespace));
        expect(anchor.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all()).toEqual(
          [{ name: "openclaw_engine_anchor" }],
        );
      }
      const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
      await client.query(
        `INSERT INTO ${quote(namespaces[0]!)}.config_machine_state (state_key, value_json, updated_at_ms) VALUES ($1, $2, 1), ($3, $4, 1)`,
        [
          "plugins.bundledDiscovery",
          JSON.stringify("allowlist"),
          "plugins.installedIndex",
          JSON.stringify({
            revision: 1,
            index: {
              installRecords: {
                workboard: { source: "path", sourcePath: workboard, installPath: workboard },
              },
            },
          }),
        ],
      );
      await client.query(
        `INSERT INTO ${quote(namespaces[1]!)}.workboard_boards (id, created_at, updated_at) VALUES ('preserved', 1, 2)`,
      );
      // Bootstrap represents the service's previous process; the updater boots independently.
      resetDatabaseEngineSelectionForTest();
      installDatabaseEngineSelection({ input: callerEngine === "postgres" ? input : undefined });
      expect(getDatabaseEngineSelection()?.input).toEqual(
        callerEngine === "postgres" ? input : undefined,
      );
      const before = await Promise.all([shared, plugin].map((file) => fs.readFile(file)));
      owner = acquireGatewayStateOwner({ databasePath: shared });
      maintenance = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: owner.assertCurrent,
        assertDatabaseAccess: owner.assertDatabaseAccess,
      });
      const backupRoot = path.join(root, "rollback");
      // Port descriptors still require bundled resources even with discovery disabled.
      // The plugin must enter capture before that separate, existing export refusal.
      await expect(
        maintenance!.run(() =>
          createUpdateDatabaseBackup({
            backupRoot,
            stateDir,
            env,
            config: {
              database: {
                engine: "postgres",
                postgres: {
                  connection: {
                    source: "env",
                    provider: "default",
                    id: "OPENCLAW_TEST_PG_BACKUP_CONNECTION",
                  },
                  schemaPrefix: input.schemaPrefix,
                },
              },
              plugins: { entries: { workboard: { enabled: false } } },
            },
            stopped: true,
          }),
        ),
      ).rejects.toThrow("State schema inspection failed");
      const directory = `${backupRoot}.databases`;
      const snapshots = (await fs.readdir(directory, { recursive: true })).filter(
        (file) => path.basename(file) === "workboard.sqlite",
      );
      expect(snapshots).toHaveLength(1);
      using captured = new DatabaseSync(path.join(directory, snapshots[0]!), { readOnly: true });
      expect(captured.prepare("SELECT engine, schema FROM openclaw_engine_anchor").get()).toEqual({
        engine: "postgres",
        schema: namespaces[1],
      });
      expect(
        (await client.query(`SELECT id FROM ${quote(namespaces[1]!)}.workboard_boards`)).rows,
      ).toEqual([{ id: "preserved" }]);
      expect(await Promise.all([shared, plugin].map((file) => fs.readFile(file)))).toEqual(before);
      maintenance.assertAdmission();
    } finally {
      await maintenance?.close();
      owner?.release();
      await closeOpenClawStateDatabaseByPathAsync(shared);
      for (const namespace of namespaces) {
        await client.query(`DROP SCHEMA IF EXISTS "${namespace.replaceAll('"', '""')}" CASCADE`);
      }
      await client.end();
    }
  },
);
