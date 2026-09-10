import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backupRestoreCommand } from "../commands/backup-restore.js";
import * as backupShared from "../commands/backup-shared.js";
import { verifyBackupArchive } from "../commands/backup-verify.js";
import { createConfigIO } from "../config/config.js";
import { MAX_INCLUDE_DEPTH } from "../config/includes.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import * as sqliteCapture from "./backup-sqlite-snapshot.js";
import { requireNodeSqlite, resolveSqliteFilesystemPath } from "./node-sqlite.js";

const runtime: RuntimeEnv = { log: () => {}, error: () => {}, exit: () => {} };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function configGraph(state: OpenClawTestState) {
  vi.stubEnv("BACKUP_INCLUDE_PLACEHOLDER", "synthetic-placeholder-value");
  const configDir = path.dirname(state.configPath);
  const includePath = path.join(configDir, "parts", "settings.json5");
  const leafPath = path.join(configDir, "parts", "leaf.json5");
  const root = `// authored root\n{ "$include": "./parts/settings.json5", agents: { ownership: "explicit", entries: { main: {} } } }\n`;
  const include = `{ "$include": "./leaf.json5" }\n`;
  const leaf = `// keep comments and placeholders\n{ gateway: { mode: "local", auth: { mode: "token", token: "\${BACKUP_INCLUDE_PLACEHOLDER}" } } }\n`;
  await fs.mkdir(path.dirname(includePath), { recursive: true });
  await fs.writeFile(state.configPath, root);
  await fs.writeFile(includePath, include);
  await fs.writeFile(leafPath, leaf);
  const snapshot = await createConfigIO({ observe: false }).readConfigFileSnapshot();
  expect(snapshot.issues).toEqual([]);
  return {
    includePath,
    leafPath,
    files: new Map([
      [state.configPath, root],
      [includePath, include],
      [leafPath, leaf],
    ]),
  };
}

async function restore(state: OpenClawTestState, output: string, includeWorkspace = true) {
  const archive = await createBackupArchive({ output, includeWorkspace });
  await verifyBackupArchive(output);
  const restored = await backupRestoreCommand(runtime, {
    archive: output,
    target: state.path("restored"),
  });
  const restoredPath = (source: string) =>
    path.join(
      restored.targetPath,
      backupShared.buildBackupArchivePath(archive.archiveRoot, source),
    );
  return { archive, restoredPath };
}

describe("full backup config include capture", () => {
  it.each([
    { name: "external config", layout: "split", rootLink: false, invalid: false },
    { name: "in-state config", layout: "state-only", rootLink: false, invalid: false },
    { name: "root link", layout: "state-only", rootLink: true, invalid: false },
    { name: "schema-invalid config", layout: "split", rootLink: false, invalid: true },
  ] as const)(
    "restores a raw nested graph through $name without the original includes",
    async ({ layout, rootLink, invalid }) => {
      await withOpenClawTestState({ layout }, async (state) => {
        vi.stubEnv("BACKUP_INCLUDE_PLACEHOLDER", "must-not-be-expanded");
        const graph = await configGraph(state);
        if (invalid) {
          const raw = graph.files
            .get(state.configPath)!
            .replace('ownership: "explicit"', "defaults: { workspace: 42 }");
          graph.files.set(state.configPath, raw);
          await fs.writeFile(state.configPath, raw);
        }
        if (rootLink) {
          const authoredRoot = state.path("authored-config.json5");
          await fs.rename(state.configPath, authoredRoot);
          await fs.symlink(authoredRoot, state.configPath);
        }
        await fs.writeFile(state.statePath("ordinary.txt"), "ordinary");
        const { archive, restoredPath } = await restore(
          state,
          state.path("backup.tar.gz"),
          !invalid,
        );
        const entries: string[] = [];
        await tar.t({
          file: archive.archivePath,
          onReadEntry: (entry) => {
            entries.push(entry.path);
          },
        });
        expect(new Set(entries).size).toBe(entries.length);
        for (const [source, raw] of graph.files) {
          expect(await fs.readFile(restoredPath(source), "utf8")).toBe(raw);
        }
        expect(await fs.readFile(restoredPath(state.statePath("ordinary.txt")), "utf8")).toBe(
          "ordinary",
        );
        // Remove only this fixture's source lookup, so parsing cannot succeed by
        // accidentally reading the originals instead of the restored graph.
        await fs.rename(
          path.join(path.dirname(state.configPath), "parts"),
          state.path("original-parts"),
        );
        const snapshot = await createConfigIO({
          configPath: restoredPath(state.configPath),
          observe: false,
        }).readConfigFileSnapshot();
        expect(snapshot.valid).toBe(!invalid);
        expect(snapshot.includeProvenance).toBeDefined();
        expect(snapshot.issues.map((issue) => issue.path)).toEqual(
          invalid ? ["agents.defaults.workspace"] : [],
        );
        expect(archive.skipped.some(({ reason }) => reason === "unresolved")).toBe(invalid);
        expect(snapshot.config.gateway?.mode).toBe("local");
      });
    },
  );

  it("keeps required workspace includes but leaves only-config root-only", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const workspace = state.statePath("workspace");
      await fs.mkdir(workspace);
      const leaf = path.join(workspace, "required.json5");
      await fs.writeFile(leaf, '{ gateway: { mode: "local" } }');
      await fs.writeFile(path.join(workspace, "workspace-only.txt"), "omit");
      await state.writeConfig({
        $include: "./workspace/required.json5",
        agents: { defaults: { workspace }, entries: { main: {} } },
      });
      const { restoredPath } = await restore(state, state.path("full.tar.gz"), false);
      expect(await fs.readFile(restoredPath(leaf), "utf8")).toContain('mode: "local"');
      await expect(
        fs.stat(restoredPath(path.join(workspace, "workspace-only.txt"))),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const rootOnly = await createBackupArchive({
        output: state.path("root.tar.gz"),
        onlyConfig: true,
      });
      await verifyBackupArchive(rootOnly.archivePath);
      const entries: string[] = [];
      await tar.t({
        file: rootOnly.archivePath,
        onReadEntry: (entry) => {
          entries.push(entry.path);
        },
      });
      expect(entries).toEqual(
        expect.arrayContaining([
          backupShared.buildBackupArchivePath(rootOnly.archiveRoot, state.configPath),
        ]),
      );
      expect(entries.some((entry) => entry.endsWith("required.json5"))).toBe(false);
    });
  });

  it.each(["missing", "cycle", "depth", "alias", "invalid-directive"])(
    "refuses an indeterminate %s graph before publication",
    async (kind) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const graph = await configGraph(state);
        if (kind === "missing") {
          await fs.unlink(graph.leafPath);
        }
        if (kind === "cycle") {
          await fs.writeFile(graph.leafPath, '{ "$include": "./settings.json5" }');
        }
        if (kind === "depth") {
          await fs.writeFile(graph.leafPath, '{ "$include": "./depth-0.json5" }');
          for (let i = 0; i <= MAX_INCLUDE_DEPTH; i++) {
            await fs.writeFile(
              path.join(path.dirname(graph.leafPath), `depth-${i}.json5`),
              i === MAX_INCLUDE_DEPTH
                ? "{}"
                : JSON.stringify({ $include: `./depth-${i + 1}.json5` }),
            );
          }
        }
        if (kind === "alias") {
          const moved = path.join(path.dirname(state.configPath), "real-parts");
          await fs.rename(path.dirname(graph.leafPath), moved);
          await fs.symlink(
            moved,
            path.dirname(graph.leafPath),
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        if (kind === "invalid-directive") {
          await fs.writeFile(state.configPath, '{ "$include": 123 }');
        }
        const output = state.path("refused.tar.gz");
        await expect(createBackupArchive({ output, includeWorkspace: false })).rejects.toThrow(
          /required config file .*retry backup/s,
        );
        await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
        // Even an unresolved graph can still be exported explicitly as root-only.
        const rootOnly = await createBackupArchive({
          output: state.path("root-only.tar.gz"),
          onlyConfig: true,
        });
        await verifyBackupArchive(rootOnly.archivePath);
      });
    },
  );

  it.each(["leaf", "root-edge", "replacement", "unreadable"])(
    "refuses %s changes after discovery without overwriting sources",
    async (kind) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const graph = await configGraph(state);
        const resolve = backupShared.resolveBackupPlanFromDisk;
        vi.spyOn(backupShared, "resolveBackupPlanFromDisk").mockImplementationOnce(
          async (options) => {
            const plan = await resolve(options);
            if (kind === "leaf") {
              const stat = await fs.stat(graph.leafPath);
              await fs.writeFile(
                graph.leafPath,
                graph.files.get(graph.leafPath)!.replace("local", "other"),
              );
              await fs.utimes(graph.leafPath, stat.atime, stat.mtime);
            } else if (kind === "root-edge") {
              await fs.writeFile(
                state.configPath,
                graph.files.get(state.configPath)!.replace("settings", "replaced"),
              );
            } else if (kind === "replacement") {
              await fs.rename(graph.leafPath, `${graph.leafPath}.original`);
              await fs.writeFile(graph.leafPath, graph.files.get(graph.leafPath)!);
            } else {
              const open = fs.open;
              vi.spyOn(fs, "open").mockImplementation(async (...args) => {
                if (args[0] === graph.leafPath) {
                  throw Object.assign(new Error("denied"), { code: "EACCES" });
                }
                return open(...args);
              });
            }
            return plan;
          },
        );
        const output = state.path("refused.tar.gz");
        await expect(createBackupArchive({ output, includeWorkspace: false })).rejects.toThrow(
          /required config file .*retry backup/s,
        );
        await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
        if (kind === "leaf") {
          expect(await fs.readFile(graph.leafPath, "utf8")).toContain('mode: "other"');
        }
        if (kind === "root-edge") {
          expect(await fs.readFile(state.configPath, "utf8")).toContain("replaced.json5");
        }
        if (kind === "replacement") {
          expect(await fs.readFile(`${graph.leafPath}.original`, "utf8")).toBe(
            graph.files.get(graph.leafPath),
          );
        }
      });
    },
  );

  it("uses sealed config even if sources change before database capture and tar traversal", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const graph = await configGraph(state);
      const { DatabaseSync } = requireNodeSqlite();
      const dbPath = state.statePath("proof.sqlite");
      const db = new DatabaseSync(dbPath);
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('captured');",
      );
      expect((await fs.stat(`${dbPath}-wal`)).size).toBeGreaterThan(0);
      const snapshotSqlite = sqliteCapture.createBackupSqliteSnapshotPlan;
      vi.spyOn(sqliteCapture, "createBackupSqliteSnapshotPlan").mockImplementationOnce(
        async (params) => {
          const snapshot = await snapshotSqlite(params);
          await fs.writeFile(graph.leafPath, '{ gateway: { mode: "remote" } }');
          db.exec("INSERT INTO proof VALUES ('later')");
          return snapshot;
        },
      );
      try {
        const { restoredPath } = await restore(state, state.path("backup.tar.gz"));
        expect(db.prepare("SELECT value FROM proof").all()).toEqual([
          { value: "captured" },
          { value: "later" },
        ]);
        const copy = new DatabaseSync(resolveSqliteFilesystemPath(restoredPath(dbPath)), {
          readOnly: true,
        });
        try {
          expect(copy.prepare("SELECT value FROM proof").all()).toEqual([{ value: "captured" }]);
        } finally {
          copy.close();
        }
        expect(await fs.readFile(graph.leafPath, "utf8")).toContain('mode: "remote"');
        expect(await fs.readFile(restoredPath(graph.leafPath), "utf8")).toBe(
          graph.files.get(graph.leafPath),
        );
      } finally {
        db.close();
      }
    });
  });

  it.each(["present", "missing"])(
    "does not archive a later include-bearing root that was %s without includes at capture",
    async (initial) => {
      await withOpenClawTestState(
        { layout: initial === "present" ? "split" : "state-only" },
        async (state) => {
          const graph = await configGraph(state);
          const plain = "{ agents: { entries: { main: {} } } }\n";
          if (initial === "present") {
            await fs.writeFile(state.configPath, plain);
          } else {
            await fs.unlink(state.configPath);
          }
          const snapshotSqlite = sqliteCapture.createBackupSqliteSnapshotPlan;
          vi.spyOn(sqliteCapture, "createBackupSqliteSnapshotPlan").mockImplementationOnce(
            async (params) => {
              await fs.writeFile(state.configPath, graph.files.get(state.configPath)!);
              return snapshotSqlite(params);
            },
          );
          const { restoredPath } = await restore(state, state.path("plain.tar.gz"));
          expect(await fs.readFile(state.configPath, "utf8")).toBe(
            graph.files.get(state.configPath),
          );
          if (initial === "present") {
            expect(await fs.readFile(restoredPath(state.configPath), "utf8")).toBe(plain);
          } else {
            await expect(fs.stat(restoredPath(state.configPath))).rejects.toMatchObject({
              code: "ENOENT",
            });
          }
        },
      );
    },
  );

  it("refuses a root alias retargeted after sealing and cleans the unpublished archive", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const first = state.statePath("first.json");
      const second = state.statePath("second.json");
      await fs.writeFile(first, "{}");
      await fs.writeFile(second, "{}");
      await fs.symlink(first, state.configPath);
      const snapshotSqlite = sqliteCapture.createBackupSqliteSnapshotPlan;
      vi.spyOn(sqliteCapture, "createBackupSqliteSnapshotPlan").mockImplementationOnce(
        async (params) => {
          await fs.unlink(state.configPath);
          await fs.symlink(second, state.configPath);
          return snapshotSqlite(params);
        },
      );
      const output = state.path("retargeted.tar.gz");
      await expect(createBackupArchive({ output })).rejects.toThrow(/config alias changed/);
      await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.realpath(state.configPath)).toBe(second);
      expect(
        (await fs.readdir(state.root)).filter((name) => name.startsWith(".openclaw-backup-")),
      ).toEqual([]);
    });
  });

  it("preserves staging ENOSPC and leaves no published archive", async () => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const graph = await configGraph(state);
      const write = fs.writeFile;
      const diskFull = Object.assign(new Error("synthetic staging disk full"), { code: "ENOSPC" });
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && /config-\d+$/.test(args[0])) {
          throw diskFull;
        }
        return write(...args);
      });
      const output = state.path("refused.tar.gz");
      await expect(createBackupArchive({ output, includeWorkspace: false })).rejects.toBe(diskFull);
      await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
      for (const [source, raw] of graph.files) {
        expect(await fs.readFile(source, "utf8")).toBe(raw);
      }
    });
  });
});
