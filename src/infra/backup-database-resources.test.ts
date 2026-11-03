import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createBackupResourcePlan } from "../commands/backup-resource-inventory.js";
import { resolveActivatedPluginBackupInventory } from "../plugins/manifest-backup-resources.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { expectDatabaseRows } from "./backup-create-family.test-support.js";
import { pluginBackupPlanInput } from "./backup-resource-plan.test-support.js";
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
      const files = [
        "active/server__user/1111111111111111",
        "active/server__user/2222222222222222",
        "disabled/server__user/3333333333333333",
      ].map((account) => state.statePath("matrix/accounts", account, "state/openclaw.sqlite"));
      const expectRetained = (snapshotPath: (file: string) => string | undefined) => {
        for (const [index, file] of files.entries()) {
          const snapshot = snapshotPath(file);
          expect(snapshot).toBeDefined();
          expectDatabaseRows(snapshot!, "SELECT value FROM retained", [
            { value: `payload-${index}` },
          ]);
        }
      };
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
      const covered = (file: string) =>
        roots.some((root) => file === root || file.startsWith(`${root}${path.sep}`));
      expect(files.every(covered)).toBe(true);
      expect(covered(unrelated)).toBe(false);
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
      expectRetained((file) => update.databases.find((entry) => entry.path === file)?.snapshotPath);

      const inventory = resolveActivatedPluginBackupInventory(input);
      const resources = await createBackupResourcePlan(
        pluginBackupPlanInput(state.stateDir, inventory),
      );
      const tempDir = state.path("backup");
      await fs.mkdir(tempDir);
      const captured = await createBackupSqliteSnapshotPlan({
        resources,
        tempDir,
        legacyAuditSnapshots: [],
      });
      expectRetained(
        (file) => captured.snapshots.find((entry) => entry.archiveSourcePath === file)?.sourcePath,
      );
    },
  );
});
