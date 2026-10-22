import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackupResourcePlan } from "../commands/backup-resource-inventory.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withBackupFixture, withDatabase } from "./backup-create-family.test-support.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries } from "./backup-create.test-support.js";
import { createBackupSqliteSnapshotPlan } from "./backup-sqlite-snapshot.js";

const PRIVACY_MARKER = ".openclaw-private-update-capture";
async function countProbes<T>(matches: (target: string) => boolean, run: () => Promise<T>) {
  let probes = 0;
  const original = fsSync.lstatSync.bind(fsSync);
  const spy = vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
    if (matches(String(target))) {
      probes += 1;
    }
    return original(target, options);
  });
  try {
    const result = await run();
    return { probes, result };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabase();
});

describe.skipIf(process.platform === "win32")("backup SQLite discovery performance", () => {
  it("keeps privacy admission proportional to worktree directories while archiving dirty files", async () => {
    await withBackupFixture({ prefix: "openclaw-backup-worktree-discovery-" }, async (state) => {
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
        stateDir: state.stateDir,
        configPaths: [state.configPath],
        oauthDirs: [],
        workspaceDirs: [],
        excludedWorkspaceDirs: [],
        agentRoots: [],
        pluginResources: [
          {
            pluginId: "nested-owner",
            disposition: "include",
            scope: "state",
            relativePath: `${worktreeRelative}/plugin-state`,
          },
        ],
        pluginRoots: [],
      });
      const measurePrivacyMarkerProbes = (label: string) =>
        countProbes(
          (target) => path.basename(target) === PRIVACY_MARKER,
          async () => {
            const tempDir = state.path(`snapshots-${label}`);
            await fs.mkdir(tempDir, { recursive: true });
            return createBackupSqliteSnapshotPlan({ resources, tempDir, legacyAuditSnapshots: [] });
          },
        );

      const baseline = await measurePrivacyMarkerProbes("baseline");
      const durableFile = path.join(sourceDirectories[0]!, "uncommitted.ts");
      await Promise.all(
        sourceDirectories.flatMap((directory) =>
          Array.from({ length: 40 }, (_, fileIndex) =>
            fs.writeFile(path.join(directory, `generated-${fileIndex}.ts`), "export {};\n"),
          ),
        ),
      );
      await fs.writeFile(durableFile, "export const keep = true;\n");

      const populated = await measurePrivacyMarkerProbes("populated");

      expect(populated.probes).toBeLessThanOrEqual(baseline.probes + 32);
      for (const file of [hardlinkAlias, pluginDatabase]) {
        expect(
          populated.result.snapshots.some(
            (snapshot) => path.resolve(snapshot.archiveSourcePath) === path.resolve(file),
          ),
        ).toBe(true);
      }
      const { probes: fileProbes, result: archive } = await countProbes(
        (target) => target === durableFile,
        () => createBackupArchive({ output: state.path("backup.tar.gz"), includeWorkspace: false }),
      );
      expect(fileProbes).toBe(1);
      const entries = await listArchiveEntries(archive.archivePath);
      const archivedDirtyFile = `/${worktreeRelative}/packages/package-0/src/uncommitted.ts`;
      expect(entries.some((entry) => entry.endsWith(archivedDirtyFile))).toBe(true);
    });
  });
});
