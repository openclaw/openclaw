import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import * as pluginBackupResources from "../plugins/doctor-contract-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createUpdateRecoveryBackup,
  restoreUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
} from "./update-recovery-backup.js";

const authority = { assertOwned() {} };
const execFileAsync = promisify(execFile);
const resolvePreferredOpenClawTmpDirMock = vi.hoisted(() => vi.fn<() => string>());
vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: resolvePreferredOpenClawTmpDirMock,
}));

async function runLanceDb(databasePath: string, operation: string): Promise<string> {
  // The plugin owns this dependency; separate processes release native database handles.
  const result = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { connect } from "@lancedb/lancedb";
const connection = await connect(process.argv[1]);
try {
  ${operation}
} finally {
  connection.close();
}`,
      databasePath,
    ],
    { cwd: fileURLToPath(new URL("../../extensions/memory-lancedb", import.meta.url)) },
  );
  return result.stdout.trim();
}

describe("update recovery database directories", () => {
  it("refuses a directory replaced by an outside symlink during pruning", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const coordinatorDir = state.path("coordinator");
      await fs.mkdir(coordinatorDir, { mode: 0o700 });
      resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
      await state.writeConfig({ plugins: { enabled: false } });
      const databasePath = state.path("database");
      const outsidePath = state.path("outside");
      await fs.mkdir(databasePath);
      await fs.mkdir(outsidePath);
      await fs.writeFile(path.join(databasePath, "original"), "captured data");
      await fs.writeFile(path.join(outsidePath, "original"), "unrelated original");
      await fs.writeFile(path.join(outsidePath, "new"), "unrelated new data");
      const declaration = vi
        .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
        .mockResolvedValue([{ path: databasePath, kind: "directory" }]);
      try {
        const ref = await createUpdateRecoveryBackup({
          ...authority,
          installRoot: state.path("install"),
          runId: "directory-swap",
        });
        await fs.writeFile(path.join(databasePath, "new"), "migration data");
        const readdir = fs.readdir;
        let swapped = false;
        const listing = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
          const result = await readdir(...args);
          if (String(args[0]) === databasePath && !swapped) {
            swapped = true;
            await fs.rename(databasePath, state.path("moved-database"));
            await fs.symlink(outsidePath, databasePath, "junction");
          }
          return result;
        });
        try {
          await expect(restoreUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
            /changed|alias/,
          );
          expect(swapped).toBe(true);
          expect(await fs.readFile(path.join(outsidePath, "original"), "utf8")).toBe(
            "unrelated original",
          );
          expect(await fs.readFile(path.join(outsidePath, "new"), "utf8")).toBe(
            "unrelated new data",
          );
        } finally {
          listing.mockRestore();
        }
      } finally {
        declaration.mockRestore();
      }
    });
  });

  it("restores captured LanceDB schema and rows without newer manifests or changes outside its directory", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const coordinatorDir = state.path("coordinator");
      await fs.mkdir(coordinatorDir, { mode: 0o700 });
      resolvePreferredOpenClawTmpDirMock.mockReturnValue(coordinatorDir);
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
      });
      const databasePath = state.path("memory", "lancedb");
      await runLanceDb(
        databasePath,
        `const table = await connection.createTable("memories", [{ id: "original", text: "captured memory" }]);
table.close();`,
      );
      const versionsPath = path.join(databasePath, "memories.lance", "_versions");
      const capturedManifests = (await fs.readdir(versionsPath)).toSorted();
      const declaration = vi
        .spyOn(pluginBackupResources, "collectPluginDoctorMigrationBackupResources")
        .mockResolvedValue([{ path: databasePath, kind: "directory" }]);
      try {
        const ref = await createUpdateRecoveryBackup({
          ...authority,
          installRoot: state.path("install"),
          runId: "lancedb-directory",
        });
        const manifest = await verifyUpdateRecoveryBackup(ref);
        expect(manifest.entries).toContainEqual({
          kind: "directory",
          sourcePath: databasePath,
          mode: (await fs.stat(databasePath)).mode & 0o777,
        });
        await runLanceDb(
          databasePath,
          `const table = await connection.openTable("memories");
try {
  await table.addColumns([{ name: "agentId", valueSql: "'main'" }]);
  await table.add([{ id: "new", text: "migration memory", agentId: "main" }]);
} finally {
  table.close();
}`,
        );
        expect((await fs.readdir(versionsPath)).length).toBeGreaterThan(capturedManifests.length);
        const unrelatedPath = state.path("memory", "operator-note.txt");
        await fs.writeFile(unrelatedPath, "new sibling data");
        const outsidePath = state.path("unrelated-database");
        await fs.mkdir(outsidePath);
        await fs.writeFile(path.join(outsidePath, "keep.txt"), "outside link target");
        await fs.symlink(outsidePath, path.join(databasePath, "new-link"), "junction");
        await fs.mkdir(path.join(databasePath, "new-directory"));
        await fs.writeFile(path.join(databasePath, "new-directory", "new-data"), "migration data");

        await restoreUpdateRecoveryBackup(ref, authority);

        const restored = JSON.parse(
          await runLanceDb(
            databasePath,
            `const table = await connection.openTable("memories");
try {
  console.log(JSON.stringify({
    columns: (await table.schema()).fields.map((field) => field.name),
    rows: await table.query().toArray(),
    version: await table.version(),
  }));
} finally {
  table.close();
}`,
          ),
        );
        expect(restored).toEqual({
          columns: ["id", "text"],
          rows: [{ id: "original", text: "captured memory" }],
          version: 1,
        });
        expect((await fs.readdir(versionsPath)).toSorted()).toEqual(capturedManifests);
        await expect(fs.lstat(path.join(databasePath, "new-directory"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(fs.lstat(path.join(databasePath, "new-link"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(await fs.readFile(unrelatedPath, "utf8")).toBe("new sibling data");
        expect(await fs.readFile(path.join(outsidePath, "keep.txt"), "utf8")).toBe(
          "outside link target",
        );
      } finally {
        declaration.mockRestore();
      }
    });
  });
});
