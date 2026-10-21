import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackupResourcePlan } from "../commands/backup-resource-inventory.js";
import { resolveActivatedPluginBackupInventory } from "../plugins/manifest-backup-resources.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  declarePluginSqliteResources,
  expectDatabaseRows,
  withBackupFixture,
  withDatabase,
} from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries } from "./backup-create.test-support.js";
import {
  createBackupSqliteSnapshotPlan,
  discoverBackupDatabasePaths,
} from "./backup-sqlite-snapshot.js";
import { statePortProvider } from "./database-engine/state-port.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "./update-candidate-state.js";
import { createUpdateDatabaseBackup } from "./update-database-backup.js";

const resourceDefaults = {
  configPaths: [],
  oauthDirs: [],
  workspaceDirs: [],
  excludedWorkspaceDirs: [],
  agentRoots: [],
  pluginRoots: [],
};

it("captures every retained account and token database under a disabled plugin's declared state resource", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prefix: "declared-state-roots-" },
    async (state) => {
      const config = await declarePluginSqliteResources(state, "matrix", {
        enabled: false,
        databaseFamily: "state",
      });
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
      const resources = await createBackupResourcePlan({
        ...resourceDefaults,
        stateDir: state.stateDir,
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
      expectRetained(
        (file) => captured.snapshots.find((entry) => entry.archiveSourcePath === file)?.sourcePath,
      );
    },
  );
});

describe.skipIf(process.platform === "win32")("backup SQLite discovery performance", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeOpenClawStateDatabase();
  });

  it("keeps privacy admission proportional to worktree directories while archiving dirty files", async () => {
    await withBackupFixture({ prefix: "openclaw-backup-worktree-discovery-" }, async (state) => {
      const probes = vi.spyOn(fsSync, "lstatSync");
      const countProbes = (matches: (target: string) => boolean) =>
        probes.mock.calls.filter(([target]) => matches(String(target))).length;
      const countMarkers = () =>
        countProbes((target) => path.basename(target) === ".openclaw-private-update-capture");
      openOpenClawStateDatabase({ env: state.env });
      closeOpenClawStateDatabase();

      const worktreeRelative = "worktrees/repository/active";
      const worktree = state.statePath(worktreeRelative);
      const sourceDirectories = Array.from({ length: 12 }, (_, index) =>
        path.join(worktree, "packages", `package-${index}`, "src"),
      );
      await Promise.all(
        sourceDirectories.map((directory) => fs.mkdir(directory, { recursive: true })),
      );

      const globalDatabase = resolveOpenClawStateSqlitePath(state.env);
      const hardlinkAlias = path.join(worktree, "state-alias.sqlite");
      await fs.link(globalDatabase, hardlinkAlias);
      const pluginDatabase = path.join(worktree, "plugin-state", "owner.sqlite");
      await fs.mkdir(path.dirname(pluginDatabase), { recursive: true });
      withDatabase(pluginDatabase, (pluginState) => {
        pluginState.exec("CREATE TABLE durable_state (value TEXT NOT NULL)");
      });

      const resources = await createBackupResourcePlan({
        ...resourceDefaults,
        stateDir: state.stateDir,
        configPaths: [state.configPath],
        pluginResources: [
          {
            pluginId: "nested-owner",
            disposition: "include",
            scope: "state",
            relativePath: `${worktreeRelative}/plugin-state`,
          },
        ],
      });
      const snapshot = async (label: string) => {
        const tempDir = state.path(`snapshots-${label}`);
        await fs.mkdir(tempDir, { recursive: true });
        probes.mockClear();
        return createBackupSqliteSnapshotPlan({ resources, tempDir, legacyAuditSnapshots: [] });
      };
      await snapshot("baseline");
      const baseline = countMarkers();
      const durableFile = path.join(sourceDirectories[0]!, "uncommitted.ts");
      await Promise.all(
        sourceDirectories.flatMap((directory) =>
          Array.from({ length: 40 }, (_, fileIndex) =>
            fs.writeFile(path.join(directory, `generated-${fileIndex}.ts`), "export {};\n"),
          ),
        ),
      );
      await fs.writeFile(durableFile, "export const keep = true;\n");

      const populated = await snapshot("populated");
      expect(countMarkers()).toBeLessThanOrEqual(baseline + 32);
      for (const file of [hardlinkAlias, pluginDatabase]) {
        expect(
          populated.snapshots.some(
            (entry) => path.resolve(entry.archiveSourcePath) === path.resolve(file),
          ),
        ).toBe(true);
      }
      probes.mockClear();
      const archive = await createBackupArchive({
        output: state.path("backup.tar.gz"),
        includeWorkspace: false,
      });
      expect(countProbes((target) => target === durableFile)).toBe(1);
      const entries = await listArchiveEntries(archive.archivePath);
      const archivedDirtyFile = `/${worktreeRelative}/packages/package-0/src/uncommitted.ts`;
      expect(entries.some((entry) => entry.endsWith(archivedDirtyFile))).toBe(true);
    });
  });
});
