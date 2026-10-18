import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackupResourcePlan } from "../commands/backup-resource-inventory.js";
import { resolveActivatedPluginBackupInventory } from "../plugins/manifest-backup-resources.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createBackupSqliteSnapshotPlan,
  discoverBackupDatabasePaths,
} from "./backup-sqlite-snapshot.js";
import { statePortProvider } from "./database-engine/state-port.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "./update-candidate-state.js";
import { createUpdateDatabaseBackup } from "./update-database-backup.js";

it("captures every retained account and token database under a disabled plugin's declared state resource", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prefix: "declared-state-roots-" },
    async (state) => {
      await fs.mkdir(state.path("plugin"));
      const fixture = createColdPluginFixture({
        rootDir: state.path("plugin"),
        pluginId: "account-owner",
        manifest: {
          backupResources: [
            {
              disposition: "include",
              scope: "state",
              relativePath: "matrix",
              databaseFamily: "state",
            },
          ],
        },
      });
      const config = {
        plugins: { enabled: false, load: { paths: [fixture.rootDir] } },
      };
      await state.writeConfig(config);
      const accounts = [
        ["active", "1111111111111111"],
        ["active", "2222222222222222"],
        ["disabled", "3333333333333333"],
      ] as const;
      const files = accounts.map(([account, token]) =>
        state.statePath(
          "matrix",
          "accounts",
          account,
          "server__user",
          token,
          "state",
          "openclaw.sqlite",
        ),
      );
      for (const [index, file] of files.entries()) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        using database = openNodeSqliteDatabase(file);
        database.exec("CREATE TABLE retained (value TEXT)");
        database.prepare("INSERT INTO retained VALUES (?)").run(`payload-${index}`);
      }
      const unrelated = state.statePath("unclaimed", "unrelated.sqlite");
      await fs.mkdir(path.dirname(unrelated));
      await fs.writeFile(unrelated, "not a database");
      const input = { stateDir: state.stateDir, config, env: state.env };
      const discovered = await discoverBackupDatabasePaths(input);
      expect(discovered).toEqual(files.toSorted());
      const roots = await statePortProvider.resolveRoots({
        ...input,
        plugins: resolvePluginMetadataSnapshot(input),
      });
      expect(
        files.every((file) =>
          roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`)),
        ),
      ).toBe(true);
      expect(
        roots.some((root) => unrelated === root || unrelated.startsWith(`${root}${path.sep}`)),
      ).toBe(false);
      const inspection = await discoverUpdateStateSchemaInspectionInProcess({
        ...input,
        stagingRoot: state.path("inspection"),
      });
      const inspected = inspection.files.flatMap(([, entry]) => entry.spellings);
      expect(files.every((file) => inspected.includes(file))).toBe(true);
      expect(inspected).not.toContain(unrelated);

      const update = await createUpdateDatabaseBackup({
        ...input,
        backupRoot: state.path("retained-package"),
        additionalPaths: [],
        stopped: true,
      });
      for (const [index, file] of files.entries()) {
        const snapshot = update.databases.find((entry) => entry.path === file);
        expect(snapshot).toBeDefined();
        using database = openNodeSqliteDatabase(snapshot!.snapshotPath, { readOnly: true });
        expect(database.prepare("SELECT value FROM retained").get()?.value).toBe(
          `payload-${index}`,
        );
      }

      const inventory = resolveActivatedPluginBackupInventory(input);
      const resources = await createBackupResourcePlan({
        stateDir: state.stateDir,
        configPaths: [],
        oauthDirs: [],
        workspaceDirs: [],
        excludedWorkspaceDirs: [],
        agentRoots: [],
        pluginResources: inventory.resources,
        pluginRoots: inventory.pluginRoots,
      });
      const tempDir = state.path("backup");
      await fs.mkdir(tempDir);
      const captured = await createBackupSqliteSnapshotPlan({
        resources,
        tempDir,
        legacyAuditSnapshots: [],
      });
      for (const [index, file] of files.entries()) {
        const snapshot = captured.snapshots.find((entry) => entry.archiveSourcePath === file);
        expect(snapshot).toBeDefined();
        using database = openNodeSqliteDatabase(snapshot!.sourcePath, { readOnly: true });
        expect(database.prepare("SELECT value FROM retained").get()?.value).toBe(
          `payload-${index}`,
        );
      }
    },
  );
});
