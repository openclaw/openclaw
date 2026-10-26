// Backup restore tests cover verified whole-archive extraction and fresh-target safety.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createBackupArchive } from "../infra/backup-create.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { backupRestoreCommand } from "./backup-restore.js";
import { buildBackupArchivePath } from "./backup-shared.js";
import { encodeTarEntry } from "./backup-tar.test-support.js";
import type { BackupManifest } from "./backup-verify-manifest.js";
import { prepareBackupArchive } from "./backup-verify.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

type TestState = Parameters<Parameters<typeof withOpenClawTestState>[1]>[0];
const withState = (run: (state: TestState, archive: string, target: string) => Promise<void>) =>
  withOpenClawTestState(
    { layout: "state-only", scenario: "minimal", prefix: "oc-link-" },
    (state) => run(state, state.path("backup.tar.gz"), state.path("restored")),
  );
const DEFAULT_ARCHIVE_ROOT = "2026-08-12T00-00-00.000Z-openclaw-backup";
const DEFAULT_PAYLOAD_PATH = buildBackupArchivePath(DEFAULT_ARCHIVE_ROOT, "/tmp/openclaw.json");
const restore = (archive: string, target: string) =>
  backupRestoreCommand(createTestRuntime(), { archive, target });
const readText = (...segments: string[]) => fs.readFile(path.join(...segments), "utf8");
const expectMissing = (target: string) =>
  expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
const linkEntry = (
  entryPath: string,
  linkpath: string,
  type: "Link" | "SymbolicLink" = "SymbolicLink",
) => encodeTarEntry({ path: entryPath, type, linkpath });

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
      encodeTarEntry({ path: directoryPath, type: "Directory", mode: 0o700 }),
      linkEntry(`${DEFAULT_ARCHIVE_ROOT}/payload/directory-hardlink`, directoryPath, "Link"),
    ],
  });
}

const DECLARED_ASSET_ROOT = buildBackupArchivePath("backup", "/tmp/restore-state");
async function writeLinkedArchive(
  archivePath: string,
  entryPath: string,
  linkpath: string,
  children: Buffer[] = [],
) {
  const externalSymbolicLinks = [{ entryPath, linkpath }];
  await writeArchive({
    archivePath,
    archiveRoot: "backup",
    payloadPath: `${DECLARED_ASSET_ROOT}/openclaw.json`,
    manifest: {
      platform: "linux",
      assets: [
        { kind: "state", sourcePath: "/tmp/restore-state", archivePath: DECLARED_ASSET_ROOT },
      ],
      externalSymbolicLinks,
    },
    extraEntries: [linkEntry(entryPath, linkpath), ...children],
  });
  return externalSymbolicLinks;
}

describe("backupRestoreCommand", () => {
  it.skipIf(process.platform === "win32")(
    "escapes terminal controls in restore output while preserving the restored payload",
    async () => {
      await withState(async (state) => {
        const text = "café\u001b[31m\nforged\tend\rrow\u0007";
        const archive = state.path(`${text}.tar.gz`);
        const target = state.path(`restored-${text}`);
        await writeArchive({ archivePath: archive });
        const runtime = createTestRuntime();
        const result = await backupRestoreCommand(runtime, { archive, target });
        const report = vi.mocked(runtime.log).mock.calls.flat().join("\n");
        expect(report).toContain("café\\nforged\\tend\\rrow");
        expect(report.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
        expect(report).not.toContain("\nforged");
        expect(result).toMatchObject({ targetPath: target, archivePath: archive });
        expect(await readText(target, DEFAULT_PAYLOAD_PATH)).toBe("{}\n");
      });
    },
  );

  it("selects a captured config payload from a legacy relative alias without following live paths", async () => {
    await withState(async (_state, archivePath) => {
      const archiveRoot = "backup";
      const configPath = "/missing/openclaw.json";
      const configSourcePath = "/missing/captured.json";
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
        extraEntries: [linkEntry(aliasPath, "captured.json")],
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
      await withState(async (state, archivePath, target) => {
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
        await writeArchive({
          archivePath,
          archiveRoot,
          payloadPath: buildBackupArchivePath(archiveRoot, "/tmp/openclaw.json"),
          manifest: format === "current" ? { postgresSnapshots: [] } : {},
          extraEntries: [...files].map(([file, contents]) =>
            encodeTarEntry({ path: `${archiveRoot}/payload/${file}`, contents }),
          ),
        });
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
    await withState(async (state, archivePath, targetPath) => {
      if (mixed) {
        await state.writeConfig({
          database: {
            families: { workboard: { engine: "postgres" } },
            postgres: { connection: "postgresql://fixture" },
          },
        });
      }
      const archiveRoot = DEFAULT_ARCHIVE_ROOT;
      const payloadPath = DEFAULT_PAYLOAD_PATH;
      const hardlinkPath = `${archiveRoot}/payload/config-link`;
      await writeArchive({
        archivePath,
        archiveRoot,
        payloadPath,
        extraEntries: [
          linkEntry(hardlinkPath, path.posix.relative(archiveRoot, payloadPath), "Link"),
        ],
      });

      await expect(restore(archivePath, targetPath)).resolves.toMatchObject({
        ok: true,
        entryCount: 3,
      });
      const original = path.join(targetPath, payloadPath);
      const linked = path.join(targetPath, hardlinkPath);
      await expect(readText(linked)).resolves.toBe("{}\n");
      expect((await fs.stat(linked)).ino).toBe((await fs.stat(original)).ino);
    });
  });

  it("extracts every archive member and reports rollback warnings in JSON", async () => {
    await withState(async (_state, archivePath, targetPath) => {
      const manifest = await writeArchive({ archivePath });
      const runtime = createTestRuntime();
      const restored = await backupRestoreCommand(runtime, {
        archive: archivePath,
        target: targetPath,
        json: true,
      });
      expect(restored).toMatchObject({
        ok: true,
        archivePath,
        targetPath,
        archiveRoot: DEFAULT_ARCHIVE_ROOT,
        assetCount: 1,
        entryCount: 2,
      });
      expect(await readText(targetPath, DEFAULT_ARCHIVE_ROOT, "manifest.json")).toBe(manifest);
      expect(await readText(targetPath, DEFAULT_PAYLOAD_PATH)).toBe("{}\n");
      expect(restored.warnings.join("\n")).toMatch(/time travel/iu);
      expect(restored.warnings.join("\n")).toMatch(/WhatsApp/iu);
      expect(restored.warnings.join("\n")).toMatch(/pending approvals/iu);
      expect(restored.warnings.join("\n")).toMatch(/plugins install <spec> --force/iu);
      expect(restored.warnings.join("\n")).toMatch(/openclaw skills list/iu);
      expect(runtime.log).toHaveBeenCalledOnce();
      expect(JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0]))).toEqual(restored);
    });
  });

  it("omits agent-scoped temporary trees and preserves safe relative links across restore", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withState(async (state, _archivePath, targetPath) => {
      const outputDir = state.path("backups");
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

      const restored = await restore(backup.archivePath, targetPath);
      expect(restored.symlinkCount).toBe(1);
      const manifest = JSON.parse(
        await readText(targetPath, backup.archiveRoot, "manifest.json"),
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
        await expectMissing(path.join(restoredAgentRoot, relativeRoot));
      }
      await expect(
        readText(restoredAgentRoot, "codex-home", "sessions", "session.json"),
      ).resolves.toBe("durable session\n");
      await expect(
        fs.readlink(path.join(restoredAgentRoot, "codex-home", "sessions", "latest-session")),
      ).resolves.toBe("session.json");
    });
  });

  it("accepts an empty directory and refuses a non-empty target", async () => {
    await withState(async (state, archivePath) => {
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
      await expect(readText(nonEmptyTarget, "keep.txt")).resolves.toBe("keep\n");
    });
  });

  it("refuses insufficient target capacity before extraction and counts hardlink data once", async () => {
    await withState(async (state, archivePath) => {
      const refusedTarget = state.path("refused-target");
      const exactTarget = state.path("exact-target");
      const archiveRoot = DEFAULT_ARCHIVE_ROOT;
      const extraPath = `${archiveRoot}/payload/extra.txt`;
      const extraContents = "payload\n";
      const manifest = await writeArchive({
        archivePath,
        extraEntries: [
          encodeTarEntry({ path: extraPath, contents: extraContents }),
          linkEntry(`${archiveRoot}/payload/extra-link.txt`, extraPath, "Link"),
        ],
      });

      const realDiskSpace = fsSync.statfsSync(state.root);
      let availableBytes = 1024 * 1024;
      const statfs = vi.spyOn(fsSync, "statfsSync").mockImplementation(() => ({
        ...realDiskSpace,
        bsize: 1,
        bavail: availableBytes,
        bfree: availableBytes,
        blocks: availableBytes + 1024 * 1024,
      }));
      try {
        const refused = await restore(archivePath, refusedTarget).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(Error);
        expect((refused as Error).message).toContain(refusedTarget);
        expect((refused as Error).message).toMatch(
          /requires 256 MiB.*archive data plus 256 MiB reserve.*only 1 MiB is available/iu,
        );
        await expectMissing(refusedTarget);

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

      await expect(restore(state.path("missing-backup.tar.gz"), targetPath)).rejects.toThrow(
        /outside the live OpenClaw agent directory/iu,
      );
      await expectMissing(targetPath);
    });
  });

  it("keeps restore available when the live config is malformed", async () => {
    await withState(async (state, archivePath, targetPath) => {
      await writeArchive({ archivePath });
      await fs.writeFile(state.configPath, '{"agents":{"entries":', "utf8");

      await expect(restore(archivePath, targetPath)).resolves.toMatchObject({ targetPath });
    });
  });

  it("verifies a corrupt archive before touching an empty target", async () => {
    await withState(async (_state, archivePath, targetPath) => {
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
      await withState(async (_state, archivePath, targetPath) => {
        const entryPath = `${DECLARED_ASSET_ROOT}/link`;
        const externalSymbolicLinks = await writeLinkedArchive(archivePath, entryPath, linkpath);
        const result = await restore(archivePath, targetPath);
        expect(await fs.readlink(path.join(targetPath, entryPath))).toBe(linkpath);
        expect(result.externalSymbolicLinks ?? []).toEqual(externalSymbolicLinks);
        expect(await readText(targetPath, DECLARED_ASSET_ROOT, "openclaw.json")).toBe("{}\n");
      });
    },
  );

  it.each([
    { label: "undeclared link entry", childType: undefined },
    { label: "file beneath a symbolic link", childType: "File" as const },
    { label: "link beneath a symbolic link", childType: "SymbolicLink" as const },
  ])(
    "backupRestoreCommand rejects $label before touching the restore target",
    async ({ childType }) => {
      await withState(async (state, archivePath, targetPath) => {
        const outside = state.path("outside");
        await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, "sentinel"), "unchanged\n");
        const entryPath = childType ? `${DECLARED_ASSET_ROOT}/a` : "backup/payload/a";
        await writeLinkedArchive(
          archivePath,
          entryPath,
          outside,
          childType
            ? [
                encodeTarEntry({
                  path: `${entryPath}/b`,
                  type: childType,
                  ...(childType === "File"
                    ? { contents: "must not write\n" }
                    : { linkpath: "../openclaw.json" }),
                }),
              ]
            : [],
        );
        await expect(restore(archivePath, targetPath)).rejects.toThrow(
          childType ? /beneath a symbolic link/iu : /outside the declared backup assets/iu,
        );
        await expectMissing(targetPath);
        expect(await fs.readdir(outside)).toEqual(["sentinel"]);
        expect(await readText(outside, "sentinel")).toBe("unchanged\n");
      });
    },
  );

  it("cleans an incomplete fresh target when extraction fails", async () => {
    await withState(async (_state, archivePath, targetPath) => {
      await writeUnextractableArchive(archivePath);

      await expect(restore(archivePath, targetPath)).rejects.toThrow(
        /incomplete target was cleaned/iu,
      );
      await expectMissing(targetPath);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await expectMissing(targetPath);
    });
  });

  it("preserves the extraction error when cleanup also fails", async () => {
    await withState(async (_state, archivePath, targetPath) => {
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
