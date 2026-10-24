// Backup restore tests cover verified whole-archive extraction and fresh-target safety.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { describe, expect, it, vi } from "vitest";
import { createBackupArchive } from "../infra/backup-create.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { backupRestoreCommand } from "./backup-restore.js";
import { buildBackupArchivePath } from "./backup-shared.js";
import type { BackupManifest } from "./backup-verify-manifest.js";
import { prepareBackupArchive, verifyBackupArchive } from "./backup-verify.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const withState = (run: Parameters<typeof withOpenClawTestState>[1]) =>
  withOpenClawTestState({ layout: "state-only", scenario: "minimal", prefix: "oc-link-" }, run);
const DEFAULT_ARCHIVE_ROOT = "2026-08-12T00-00-00.000Z-openclaw-backup";
const DEFAULT_PAYLOAD_PATH = buildBackupArchivePath(DEFAULT_ARCHIVE_ROOT, "/tmp/openclaw.json");
const restore = (archive: string, target: string) =>
  backupRestoreCommand(createTestRuntime(), { archive, target });

async function listArchiveLeafEntries(archivePath: string): Promise<string[]> {
  const entries: string[] = [];
  await tar.t({
    file: archivePath,
    gzip: true,
    onReadEntry: (entry) => {
      if (entry.type !== "Directory") {
        entries.push(entry.path.replace(/\/+$/u, ""));
      }
    },
  });
  return entries.toSorted();
}

async function listFilesystemLeafEntries(root: string, relative = ""): Promise<string[]> {
  const entries: string[] = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      entries.push(...(await listFilesystemLeafEntries(root, child)));
    } else {
      entries.push(child.split(path.sep).join("/"));
    }
  }
  return entries.toSorted();
}

function encodeTarEntry(params: {
  path: string;
  contents?: string | Buffer;
  type?: "File" | "Directory" | "Link" | "SymbolicLink";
  linkpath?: string;
}): Buffer {
  const body = Buffer.isBuffer(params.contents)
    ? params.contents
    : Buffer.from(params.contents ?? "", "utf8");
  const type = params.type ?? "File";
  const header = new tar.Header({
    path: params.path,
    type,
    size: type === "File" ? body.length : 0,
    mode: type === "Directory" ? 0o700 : 0o600,
    uid: 0,
    gid: 0,
    mtime: new Date(0),
    ...(params.linkpath ? { linkpath: params.linkpath } : {}),
  });
  const headerBlock = Buffer.alloc(512);
  header.encode(headerBlock);
  if (type !== "File") {
    return headerBlock;
  }
  return Buffer.concat([headerBlock, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

async function writeArchive(params: {
  archivePath: string;
  archiveRoot?: string;
  payloadPath?: string;
  manifest?: string | Partial<BackupManifest>;
  extraEntries?: Buffer[];
}): Promise<string> {
  const root = params.archiveRoot ?? DEFAULT_ARCHIVE_ROOT;
  const payload = params.payloadPath ?? DEFAULT_PAYLOAD_PATH;
  const manifest =
    typeof params.manifest === "string"
      ? params.manifest
      : JSON.stringify({
          schemaVersion: 1,
          createdAt: "2026-08-12T00:00:00.000Z",
          archiveRoot: root,
          runtimeVersion: "test",
          platform: process.platform,
          nodeVersion: process.version,
          assets: [
            {
              kind: "config",
              sourcePath: "/tmp/openclaw.json",
              archivePath: payload,
            },
          ],
          ...params.manifest,
        }) + "\n";
  await fs.writeFile(
    params.archivePath,
    gzipSync(
      Buffer.concat([
        encodeTarEntry({ path: `${root}/manifest.json`, contents: manifest }),
        encodeTarEntry({ path: payload, contents: "{}\n" }),
        ...(params.extraEntries ?? []),
        Buffer.alloc(1024),
      ]),
    ),
  );
  return manifest;
}

async function writeUnextractableArchive(archivePath: string) {
  const directoryPath = `${DEFAULT_ARCHIVE_ROOT}/payload/invalid-hardlink-target`;
  await writeArchive({
    archivePath,
    extraEntries: [
      encodeTarEntry({ path: directoryPath, type: "Directory" }),
      encodeTarEntry({
        path: `${DEFAULT_ARCHIVE_ROOT}/payload/directory-hardlink`,
        type: "Link",
        linkpath: directoryPath,
      }),
    ],
  });
}

describe("backupRestoreCommand", () => {
  it("selects a captured config payload from a legacy relative alias without following live paths", async () => {
    await withState(async (state) => {
      const archiveRoot = "backup";
      const configPath = "/missing/openclaw.json";
      const configSourcePath = "/missing/captured.json";
      const archivePath = state.path("alias.tar.gz");
      const payloadPath = buildBackupArchivePath(archiveRoot, configSourcePath);
      const aliasPath = buildBackupArchivePath(archiveRoot, configPath);
      await writeArchive({
        archivePath,
        archiveRoot,
        payloadPath,
        manifest: {
          platform: "linux",
          paths: { configPath },
          assets: [
            { kind: "config", sourcePath: configSourcePath, archivePath: payloadPath },
            { kind: "config", sourcePath: configPath, archivePath: aliasPath },
          ],
        },
        extraEntries: [
          encodeTarEntry({ path: aliasPath, type: "SymbolicLink", linkpath: "captured.json" }),
        ],
      });

      expect(await prepareBackupArchive(archivePath)).toMatchObject({
        recoveryConfigPath: payloadPath,
        recoveryConfigContextPath: aliasPath,
      });
    });
  });

  it.each(["legacy", "current"])(
    "preserves opaque SQLite and PostgreSQL-named files in %s archives",
    async (format) => {
      await withState(async (state) => {
        const databasePath = state.path("ordinary.sqlite");
        {
          const sqlite = requireNodeSqlite();
          using database = new sqlite.DatabaseSync(databasePath);
          database.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('user note')");
        }
        const archiveRoot = "backup";
        const damaged = Buffer.alloc(128);
        damaged.write("SQLite format 3\0");
        const files = new Map([
          ["notes.postgres/manifest.json", Buffer.from("user document\n")],
          ["lookalike.postgres/manifest.json", Buffer.from('{"source":{"engine":"postgres"}}')],
          ["ordinary.sqlite", await fs.readFile(databasePath)],
          ["ordinary.sqlite.postgres/manifest.json", Buffer.from("another user document\n")],
          ["text.sqlite", Buffer.from("plain text named sqlite\n")],
          ["damaged.sqlite", damaged],
        ]);
        const archivePath = state.path("user-files.tar.gz");
        await writeArchive({
          archivePath,
          archiveRoot,
          payloadPath: buildBackupArchivePath(archiveRoot, "/tmp/openclaw.json"),
          manifest: format === "current" ? { postgresSnapshots: [] } : {},
          extraEntries: [...files].map(([file, contents]) =>
            encodeTarEntry({ path: `${archiveRoot}/payload/${file}`, contents }),
          ),
        });
        const target = state.path("restored");
        await restore(archivePath, target);
        for (const [file, contents] of files) {
          expect(await fs.readFile(path.join(target, archiveRoot, "payload", file))).toEqual(
            contents,
          );
        }
      });
    },
  );

  it.each([false, true])("restores verified root-relative hardlinks (mixed: %s)", async (mixed) => {
    await withState(async (state) => {
      if (mixed) {
        await state.writeConfig({
          database: {
            families: { workboard: { engine: "postgres" } },
            postgres: { connection: "postgresql://fixture" },
          },
        });
      }
      const archivePath = state.path("backup.tar.gz");
      const targetPath = state.path("restored");
      const archiveRoot = DEFAULT_ARCHIVE_ROOT;
      const payloadPath = DEFAULT_PAYLOAD_PATH;
      const hardlinkPath = `${archiveRoot}/payload/config-link`;
      await writeArchive({
        archivePath,
        archiveRoot,
        payloadPath,
        extraEntries: [
          encodeTarEntry({
            path: hardlinkPath,
            type: "Link",
            linkpath: path.posix.relative(archiveRoot, payloadPath),
          }),
        ],
      });

      await expect(verifyBackupArchive(archivePath)).resolves.toMatchObject({ ok: true });
      await expect(restore(archivePath, targetPath)).resolves.toMatchObject({
        ok: true,
        entryCount: 3,
      });
      const original = path.join(targetPath, payloadPath);
      const linked = path.join(targetPath, hardlinkPath);
      await expect(fs.readFile(linked, "utf8")).resolves.toBe("{}\n");
      expect((await fs.stat(linked)).ino).toBe((await fs.stat(original)).ino);
    });
  });

  it("round-trips a backup into a fresh target with matching inventory and readable databases", async () => {
    await withState(async (state) => {
      const outputDir = state.path("backups");
      const targetPath = state.path("restored");
      await fs.mkdir(outputDir, { recursive: true });
      await state.writeText("operator-note.txt", "restore me\n");
      const pluginSkillTarget = state.statePath("plugin-source", "canvas");
      if (process.platform !== "win32") {
        await fs.mkdir(pluginSkillTarget, { recursive: true });
        await fs.writeFile(path.join(pluginSkillTarget, "SKILL.md"), "# Canvas\n", "utf8");
        const pluginSkillsDir = state.statePath("plugin-skills");
        await fs.mkdir(pluginSkillsDir, { recursive: true });
        await fs.symlink(
          await fs.realpath(pluginSkillTarget),
          path.join(pluginSkillsDir, "canvas"),
          "dir",
        );
      }
      openOpenClawStateDatabase({ env: state.env });

      try {
        const backup = await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: Date.UTC(2026, 7, 12, 12, 0, 0),
        });
        const runtime = createTestRuntime();
        const restored = await backupRestoreCommand(runtime, {
          archive: backup.archivePath,
          target: targetPath,
          json: true,
        });

        expect(restored).toMatchObject({
          ok: true,
          archivePath: backup.archivePath,
          targetPath,
          archiveRoot: backup.archiveRoot,
          assetCount: 1,
        });
        expect(restored.warnings.join("\n")).toMatch(/time travel/iu);
        expect(restored.warnings.join("\n")).toMatch(/WhatsApp/iu);
        expect(restored.warnings.join("\n")).toMatch(/pending approvals/iu);
        expect(restored.warnings.join("\n")).toMatch(/plugins install <spec> --force/iu);
        expect(restored.warnings.join("\n")).toMatch(/openclaw skills list/iu);
        expect(runtime.log).toHaveBeenCalledOnce();
        expect(JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]))).toEqual(restored);
        if (process.platform !== "win32") {
          expect(backup.skipped).toContainEqual(
            expect.objectContaining({
              sourcePath: state.statePath("plugin-skills"),
              reason: "regenerable",
            }),
          );
          expect(await listArchiveLeafEntries(backup.archivePath)).not.toContainEqual(
            expect.stringContaining("/plugin-skills/"),
          );
          const manifest = JSON.parse(
            await fs.readFile(path.join(targetPath, backup.archiveRoot, "manifest.json"), "utf8"),
          ) as { skipped: Array<{ sourcePath: string; reason: string }> };
          expect(manifest.skipped).toContainEqual(
            expect.objectContaining({
              sourcePath: state.statePath("plugin-skills"),
              reason: "regenerable",
            }),
          );
        }

        expect(await listFilesystemLeafEntries(targetPath)).toEqual(
          await listArchiveLeafEntries(backup.archivePath),
        );
        const databaseEntry = (await listArchiveLeafEntries(backup.archivePath)).find((entry) =>
          entry.endsWith("/state/openclaw.sqlite"),
        );
        expect(databaseEntry).toBeDefined();
        const sqlite = requireNodeSqlite();
        const database = new sqlite.DatabaseSync(path.join(targetPath, databaseEntry ?? ""), {
          readOnly: true,
        });
        try {
          expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
            integrity_check: "ok",
          });
        } finally {
          database.close();
        }
      } finally {
        closeOpenClawStateDatabase();
      }
    });
  });

  it("omits agent-scoped temporary trees and preserves safe relative links across restore", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withState(async (state) => {
      const outputDir = state.path("backups");
      const targetPath = state.path("restored");
      const agentRoot = state.statePath("agents", "main", "agent");
      const runtimeHome = path.join(agentRoot, "codex-home");
      const runtimeTempRoot = path.join(runtimeHome, "tmp");
      const marketplaceTempRoot = path.join(runtimeHome, ".tmp");
      const helperDir = path.join(runtimeTempRoot, "arg0", "codex-arg0-fixture");
      const marketplaceDir = path.join(marketplaceTempRoot, "bundled-marketplaces", "managed");
      const agentTempRoot = path.join(agentRoot, "tmp");
      const durableDir = path.join(runtimeHome, "sessions");
      const externalRuntime = state.path("external-runtime");
      const externalExecutable = path.join(externalRuntime, "executable");
      const externalBundle = path.join(externalRuntime, "desktop-bundle");
      await Promise.all(
        [
          outputDir,
          helperDir,
          marketplaceDir,
          path.join(agentTempRoot, "resources"),
          durableDir,
          externalBundle,
        ].map((directory) => fs.mkdir(directory, { recursive: true })),
      );
      await fs.writeFile(externalExecutable, "must never enter the backup\n", "utf8");
      await fs.symlink(externalExecutable, path.join(helperDir, "apply_patch"));
      await fs.symlink(externalBundle, path.join(marketplaceDir, "bundled-plugin"), "dir");
      await fs.writeFile(path.join(agentTempRoot, "resources", "scratch.sqlite"), "not sqlite\n");
      await fs.writeFile(path.join(durableDir, "session.json"), "durable session\n");
      await fs.symlink("session.json", path.join(durableDir, "latest-session"));

      const backup = await createBackupArchive({
        output: outputDir,
        includeWorkspace: false,
        nowMs: Date.UTC(2026, 7, 12, 13, 0, 0),
      });

      const omittedRoots = [runtimeTempRoot, marketplaceTempRoot, agentTempRoot].toSorted(
        (left, right) => left.localeCompare(right),
      );
      const expectedOmissions = omittedRoots.map((sourcePath) => ({
        kind: "agent temporary files",
        sourcePath,
        reason: "regenerable",
      }));
      expect(backup.skipped.filter((entry) => entry.kind === "agent temporary files")).toEqual(
        expectedOmissions.map((entry) => expect.objectContaining(entry)),
      );
      expect(backup.skippedVolatileCount).toBe(0);

      const archiveEntries = await listArchiveLeafEntries(backup.archivePath);
      expect(archiveEntries.some((entry) => entry.includes("external-runtime"))).toBe(false);
      expect(archiveEntries.some((entry) => entry.endsWith("/sessions/session.json"))).toBe(true);

      const restored = await backupRestoreCommand(createTestRuntime(), {
        archive: backup.archivePath,
        target: targetPath,
      });
      expect(restored.symlinkCount).toBe(1);
      const manifest = JSON.parse(
        await fs.readFile(path.join(targetPath, backup.archiveRoot, "manifest.json"), "utf8"),
      ) as { skipped: Array<{ kind: string; sourcePath: string; reason: string }> };
      expect(manifest.skipped.filter((entry) => entry.kind === "agent temporary files")).toEqual(
        expectedOmissions,
      );

      const stateAsset = backup.assets.find((asset) => asset.kind === "state");
      expect(stateAsset).toBeDefined();
      const restoredAgentRoot = path.join(
        targetPath,
        stateAsset?.archivePath ?? "",
        "agents",
        "main",
        "agent",
      );
      for (const omittedRoot of omittedRoots) {
        const relativeRoot = path.relative(agentRoot, omittedRoot);
        const archiveRelativeRoot = relativeRoot.split(path.sep).join("/");
        expect(
          archiveEntries.some((entry) => entry.includes(`/agent/${archiveRelativeRoot}/`)),
        ).toBe(false);
        await expect(fs.lstat(path.join(restoredAgentRoot, relativeRoot))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(
        fs.readFile(path.join(restoredAgentRoot, "codex-home", "sessions", "session.json"), "utf8"),
      ).resolves.toBe("durable session\n");
      await expect(
        fs.readlink(path.join(restoredAgentRoot, "codex-home", "sessions", "latest-session")),
      ).resolves.toBe("session.json");
      expect(
        (await listFilesystemLeafEntries(targetPath)).some((entry) =>
          entry.includes("external-runtime"),
        ),
      ).toBe(false);
    });
  });

  it("accepts an empty directory and refuses a non-empty target", async () => {
    await withState(async (state) => {
      const archivePath = state.path("backup.tar.gz");
      const emptyTarget = state.path("empty-target");
      const nonEmptyTarget = state.path("non-empty-target");
      await writeArchive({ archivePath });
      await fs.mkdir(emptyTarget);
      await fs.mkdir(nonEmptyTarget);
      await fs.writeFile(path.join(nonEmptyTarget, "keep.txt"), "keep\n");

      await expect(restore(archivePath, emptyTarget)).resolves.toMatchObject({
        targetPath: emptyTarget,
      });
      await expect(restore(archivePath, nonEmptyTarget)).rejects.toThrow(
        /target directory must be empty/iu,
      );
      await expect(fs.readFile(path.join(nonEmptyTarget, "keep.txt"), "utf8")).resolves.toBe(
        "keep\n",
      );
    });
  });

  it("refuses insufficient target capacity before extraction and counts hardlink data once", async () => {
    await withState(async (state) => {
      const archivePath = state.path("backup.tar.gz");
      const refusedTarget = state.path("refused-target");
      const exactTarget = state.path("exact-target");
      const archiveRoot = DEFAULT_ARCHIVE_ROOT;
      const extraPath = `${archiveRoot}/payload/extra.txt`;
      const extraContents = "payload\n";
      const manifest = await writeArchive({
        archivePath,
        extraEntries: [
          encodeTarEntry({ path: extraPath, contents: extraContents }),
          encodeTarEntry({
            path: `${archiveRoot}/payload/extra-link.txt`,
            type: "Link",
            linkpath: extraPath,
          }),
        ],
      });

      const realDiskSpace = fsSync.statfsSync(state.root);
      let availableBytes = 1024 * 1024;
      const statfs = vi.spyOn(fsSync, "statfsSync").mockImplementation(() => ({
        type: realDiskSpace.type,
        bsize: 1,
        bavail: availableBytes,
        bfree: availableBytes,
        blocks: availableBytes + 1024 * 1024,
        files: realDiskSpace.files,
        frsize: realDiskSpace.frsize,
        ffree: realDiskSpace.ffree,
      }));
      try {
        const refused = await restore(archivePath, refusedTarget).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(Error);
        expect((refused as Error).message).toContain(refusedTarget);
        expect((refused as Error).message).toMatch(
          /requires 256 MiB.*archive data plus 256 MiB reserve.*only 1 MiB is available/iu,
        );
        await expect(fs.lstat(refusedTarget)).rejects.toMatchObject({ code: "ENOENT" });

        const regularFileBytes =
          Buffer.byteLength(manifest) +
          Buffer.byteLength("{}\n") +
          Buffer.byteLength(extraContents);
        availableBytes = 256 * 1024 * 1024 + regularFileBytes;
        await expect(restore(archivePath, exactTarget)).resolves.toMatchObject({
          targetPath: exactTarget,
        });
        expect((await fs.stat(path.join(exactTarget, extraPath))).ino).toBe(
          (await fs.stat(path.join(exactTarget, `${archiveRoot}/payload/extra-link.txt`))).ino,
        );
      } finally {
        statfs.mockRestore();
      }
    });
  });

  it("rejects a staging target inside a configured external live agent directory", async () => {
    await withState(async (state) => {
      const agentDir = state.path("external-agent");
      const targetPath = path.join(agentDir, "restore-target");
      await fs.mkdir(agentDir, { recursive: true });
      await state.writeConfig({ agents: { entries: { main: { agentDir } } } });

      await expect(
        backupRestoreCommand(createTestRuntime(), {
          archive: state.path("missing-backup.tar.gz"),
          target: targetPath,
        }),
      ).rejects.toThrow(/outside the live OpenClaw agent directory/iu);
      await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("keeps restore available when the live config is malformed", async () => {
    await withState(async (state) => {
      const archivePath = state.path("backup.tar.gz");
      const targetPath = state.path("restore-target");
      await writeArchive({ archivePath });
      await fs.writeFile(state.configPath, '{"agents":{"entries":', "utf8");

      await expect(restore(archivePath, targetPath)).resolves.toMatchObject({ targetPath });
    });
  });

  it("verifies a corrupt archive before touching an empty target", async () => {
    await withState(async (state) => {
      const archivePath = state.path("corrupt.tar.gz");
      const targetPath = state.path("restore-target");
      await writeArchive({
        archivePath,
        manifest: "{not-json}\n",
      });
      await fs.mkdir(targetPath);

      await expect(restore(archivePath, targetPath)).rejects.toThrow(
        /manifest is not valid JSON/iu,
      );
      await expect(fs.readdir(targetPath)).resolves.toEqual([]);
    });
  });

  it.runIf(process.platform !== "win32")(
    "recreates a reported declared-asset-escaping target without rewriting it",
    async () => {
      const linkpath = "../outside-declared-assets";
      await withState(async (state) => {
        const archivePath = state.path("links.tar.gz");
        const targetPath = state.path("restored");
        const archiveRoot = "backup";
        const declaredAssetRoot = buildBackupArchivePath(archiveRoot, "/tmp/restore-state");
        const entryPath = `${declaredAssetRoot}/link`;
        const externalSymbolicLinks = [{ entryPath, linkpath }];
        await writeArchive({
          archivePath,
          archiveRoot,
          payloadPath: `${declaredAssetRoot}/openclaw.json`,
          manifest: {
            platform: "linux",
            assets: [
              { kind: "state", sourcePath: "/tmp/restore-state", archivePath: declaredAssetRoot },
            ],
            externalSymbolicLinks,
          },
          extraEntries: [encodeTarEntry({ path: entryPath, type: "SymbolicLink", linkpath })],
        });
        const result = await restore(archivePath, targetPath);
        expect(await fs.readlink(path.join(targetPath, entryPath))).toBe(linkpath);
        expect(result.externalSymbolicLinks ?? []).toEqual(externalSymbolicLinks);
        expect(
          await fs.readFile(path.join(targetPath, declaredAssetRoot, "openclaw.json"), "utf8"),
        ).toBe("{}\n");
      });
    },
  );

  it.each([
    { label: "undeclared link entry", childType: undefined, suffix: "" },
    { label: "file beneath a symbolic link", childType: "File" as const, suffix: "" },
    { label: "link beneath a symbolic link", childType: "SymbolicLink" as const, suffix: "" },
  ])(
    "backupRestoreCommand rejects $label before touching the restore target",
    async ({ childType, suffix }) => {
      await withState(async (state) => {
        const archivePath = state.path("unsafe.tar.gz");
        const targetPath = state.path("restored");
        const outside = state.path("outside");
        await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, "sentinel"), "unchanged\n");
        const archiveRoot = "backup";
        const declaredAssetRoot = buildBackupArchivePath(archiveRoot, "/tmp/restore-state");
        const entryPath = childType
          ? `${declaredAssetRoot}/a${suffix}`
          : `${archiveRoot}/payload/a`;
        await writeArchive({
          archivePath,
          archiveRoot,
          payloadPath: `${declaredAssetRoot}/openclaw.json`,
          manifest: {
            platform: "linux",
            assets: [
              { kind: "state", sourcePath: "/tmp/restore-state", archivePath: declaredAssetRoot },
            ],
            externalSymbolicLinks: [{ entryPath, linkpath: outside }],
          },
          extraEntries: [
            encodeTarEntry({ path: entryPath, type: "SymbolicLink", linkpath: outside }),
            ...(childType
              ? [
                  encodeTarEntry({
                    path: `${entryPath}/b`,
                    type: childType,
                    ...(childType === "File"
                      ? { contents: "must not write\n" }
                      : { linkpath: "../openclaw.json" }),
                  }),
                ]
              : []),
          ],
        });
        await expect(restore(archivePath, targetPath)).rejects.toThrow(
          childType ? /beneath a symbolic link/iu : /outside the declared backup assets/iu,
        );
        await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readdir(outside)).toEqual(["sentinel"]);
        expect(await fs.readFile(path.join(outside, "sentinel"), "utf8")).toBe("unchanged\n");
      });
    },
  );

  it("cleans an incomplete fresh target when extraction fails", async () => {
    await withState(async (state) => {
      const archivePath = state.path("unextractable.tar.gz");
      const targetPath = state.path("restore-target");
      await writeUnextractableArchive(archivePath);

      await expect(restore(archivePath, targetPath)).rejects.toThrow(
        /incomplete target was cleaned/iu,
      );
      await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await expect(fs.lstat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("preserves the extraction error when cleanup also fails", async () => {
    await withState(async (state) => {
      const archivePath = state.path("unextractable.tar.gz");
      const targetPath = state.path("restore-target");
      await writeUnextractableArchive(archivePath);
      const cleanupError = new Error("cleanup denied");
      vi.spyOn(fs, "rm").mockRejectedValueOnce(cleanupError);

      const restoreError = await restore(archivePath, targetPath).catch((error: unknown) => error);

      expect(restoreError).toBeInstanceOf(Error);
      expect((restoreError as Error).message).toMatch(/cleanup denied/iu);
      expect((restoreError as Error).cause).toBeInstanceOf(Error);
      expect((restoreError as Error).cause).not.toBe(cleanupError);
      expect((restoreError as AggregateError).errors).toEqual([
        (restoreError as Error).cause,
        cleanupError,
      ]);
    });
  });
});
