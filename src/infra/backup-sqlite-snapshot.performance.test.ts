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
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import { listArchiveEntries } from "./backup-create.test-support.js";
import { createBackupSqliteSnapshotPlan } from "./backup-sqlite-snapshot.js";
import { requireNodeSqlite } from "./node-sqlite.js";

const PRIVACY_MARKER = ".openclaw-private-update-capture";

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
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-worktree-discovery-",
        scenario: "minimal",
      },
      async (state) => {
        openOpenClawStateDatabase({ env: state.env });
        closeOpenClawStateDatabase();

        const worktree = state.statePath("worktrees", "repository", "active");
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
        const pluginState = new (requireNodeSqlite().DatabaseSync)(pluginDatabase);
        try {
          pluginState.exec("CREATE TABLE durable_state (value TEXT NOT NULL)");
        } finally {
          pluginState.close();
        }

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
              relativePath: "worktrees/repository/active/plugin-state",
            },
          ],
          pluginRoots: [],
        });
        const measurePrivacyMarkerProbes = async (label: string) => {
          let markerProbes = 0;
          const originalLstatSync = fsSync.lstatSync.bind(fsSync);
          const lstatSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
            if (path.basename(String(target)) === PRIVACY_MARKER) {
              markerProbes += 1;
            }
            return originalLstatSync(target, options);
          });
          try {
            const tempDir = state.path(`snapshots-${label}`);
            await fs.mkdir(tempDir, { recursive: true });
            const result = await createBackupSqliteSnapshotPlan({
              resources,
              tempDir,
              legacyAuditSnapshots: [],
            });
            return { markerProbes, result };
          } finally {
            lstatSpy.mockRestore();
          }
        };

        const baseline = await measurePrivacyMarkerProbes("baseline");
        const durableFile = path.join(sourceDirectories[0]!, "uncommitted.ts");
        await Promise.all(
          sourceDirectories.flatMap((directory, directoryIndex) =>
            Array.from({ length: 40 }, (_, fileIndex) =>
              fs.writeFile(
                path.join(directory, `generated-${fileIndex}.ts`),
                `export const value = ${directoryIndex * 40 + fileIndex};\n`,
              ),
            ),
          ),
        );
        await fs.writeFile(durableFile, "export const keep = true;\n");

        const populated = await measurePrivacyMarkerProbes("populated");

        expect(populated.markerProbes).toBeLessThanOrEqual(baseline.markerProbes + 32);
        expect(
          populated.result.snapshots.some(
            (snapshot) => path.resolve(snapshot.archiveSourcePath) === path.resolve(hardlinkAlias),
          ),
        ).toBe(true);
        expect(
          populated.result.snapshots.some(
            (snapshot) => path.resolve(snapshot.archiveSourcePath) === path.resolve(pluginDatabase),
          ),
        ).toBe(true);

        const archive = await createBackupArchive({
          output: state.path("backup.tar.gz"),
          includeWorkspace: false,
        });
        const entries = await listArchiveEntries(archive.archivePath);
        expect(
          entries.some((entry) =>
            entry.endsWith("/worktrees/repository/active/packages/package-0/src/uncommitted.ts"),
          ),
        ).toBe(true);
      },
    );
  });
});
