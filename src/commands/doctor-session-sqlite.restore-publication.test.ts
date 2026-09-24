import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as directoryDurability from "../infra/directory-durability.js";
import * as replaceFile from "../infra/replace-file.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { createCompetingRestoreTarget } from "./doctor-session-sqlite.publication.test-support.js";
import {
  runPublicSessionSqlite,
  isDirectoryDescriptor,
  readMigrationManifest,
  type SessionSqliteMigrationManifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

const { createHistoricalRestoreStore } = useDoctorSessionSqliteTestFixture();

describe("runDoctorSessionSqlite", () => {
  it.each(
    (
      [
        { version: 1, destination: "file" },
        { version: 2, destination: "file" },
        { version: 1, destination: "dangling-symlink" },
        { version: 2, destination: "dangling-symlink" },
      ] as const
    ).filter(({ destination }) => destination === "file" || process.platform !== "win32"),
  )(
    "preserves a late-created $destination during historical v$version restore without SQLite",
    async ({ version, destination }) => {
      const { store, manifestPath, manifest, archivePath } = createHistoricalRestoreStore(version);
      const original = fs.readFileSync(archivePath);
      const sourcePath = expectDefined(
        manifest.targets
          .flatMap((target) => target.plannedMoves)
          .find((move) => move.archivePath === archivePath),
        "transcript restore move",
      ).sourcePath;
      const competitorPath = path.join(store.tempDir, "competing-writer.jsonl");
      const competitorContent = "history written by a separate process\n";
      if (destination === "file") {
        fs.writeFileSync(competitorPath, competitorContent, { mode: 0o600 });
      }
      let competitorIdentity: fs.BigIntStats | undefined;
      const insertCompetitor = (from: fs.PathLike, to: fs.PathLike) => {
        if (competitorIdentity || String(from) !== archivePath || String(to) !== sourcePath) {
          return;
        }
        // Insert after Doctor's pathname guards, then forward the guarded publication.
        competitorIdentity = createCompetingRestoreTarget(destination, competitorPath, sourcePath);
      };
      const publish = directoryDurability.publishFileExclusive;
      const publicationSpy = vi
        .spyOn(directoryDurability, "publishFileExclusive")
        .mockImplementation(async (options) => {
          insertCompetitor(options.sourcePath, options.targetPath);
          return publish(options);
        });
      let result: Awaited<ReturnType<typeof runPublicSessionSqlite>>;
      try {
        result = await runPublicSessionSqlite(store, "restore");
      } finally {
        publicationSpy.mockRestore();
      }
      const created = expectDefined(competitorIdentity, "separate writer ran at publication");
      const retained = fs.lstatSync(sourcePath, { bigint: true });
      expect(retained.ino).toBe(created.ino);
      expect(retained.dev).toBe(created.dev);
      if (destination === "file") {
        expect(fs.readFileSync(sourcePath, "utf8")).toBe(competitorContent);
      } else {
        expect(retained.isSymbolicLink()).toBe(true);
        expect(fs.readlinkSync(sourcePath)).toBe(competitorPath);
        expect(fs.existsSync(competitorPath)).toBe(false);
      }
      expect(fs.readFileSync(archivePath)).toEqual(original);
      expect(result.exitCode).toBe(1);
      const restored = readMigrationManifest(manifestPath).restore;
      expect(restored?.conflicts).toEqual(
        expect.arrayContaining([expect.objectContaining({ archivePath, sourcePath })]),
      );
      expect(restored?.consumedArchives ?? []).not.toContain(archivePath);
      expect(restored?.restoredFiles ?? []).not.toContain(sourcePath);
      for (const target of manifest.targets) {
        expect(fs.existsSync(target.sqlitePath)).toBe(false);
      }
    },
  );

  it.each(
    ([1, 2] as const).flatMap((version) =>
      (["transcript", "legacy-store"] as const).map((kind) => ({ version, kind })),
    ),
  )(
    "rejects a changed historical v$version $kind before adopting restore metadata",
    async ({ version, kind }) => {
      const { store, manifestPath, manifest } = createHistoricalRestoreStore(version);
      const target = expectDefined(manifest.targets[0], "historical restore target");
      const move = expectDefined(
        target.plannedMoves.find((candidate) => candidate.kind === kind),
        "selected historical archive",
      );
      const original = fs.readFileSync(move.archivePath, "utf8");
      const changed = original.replace('"session-1"', '"session-2"');
      expect(changed).not.toBe(original);
      expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
      const identity = fs.statSync(move.archivePath, { bigint: true });
      const duplicate = { ...move, archivePath: `${move.archivePath}.duplicate` };
      fs.copyFileSync(move.archivePath, duplicate.archivePath);
      target.plannedMoves.push(duplicate);
      target.completedMoves.push({ ...duplicate });
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });

      const close = fs.closeSync;
      let injected = false;
      const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
        const opened = fs.fstatSync(fd, { bigint: true });
        close(fd);
        if (!injected && opened.dev === identity.dev && opened.ino === identity.ino) {
          // Change real bytes after the planner closes its verified descriptor, before adoption.
          injected = true;
          fs.writeFileSync(move.archivePath, changed);
        }
      });
      let result: Awaited<ReturnType<typeof runPublicSessionSqlite>>;
      try {
        result = await runPublicSessionSqlite(store, "restore");
      } finally {
        closeSpy.mockRestore();
      }
      expect(injected).toBe(true);
      expect(result.exitCode).toBe(1);
      expect(result.report.targets[0]?.restore?.conflicts).toEqual([
        {
          archivePath: move.archivePath,
          sourcePath: move.sourcePath,
          reason: "archive changed after restore planning; refusing restore",
        },
      ]);
      expect(fs.existsSync(move.sourcePath)).toBe(false);
      expect(fs.readFileSync(move.archivePath, "utf8")).toBe(changed);
      expect(fs.statSync(move.archivePath, { bigint: true }).ino).toBe(identity.ino);
      expect(fs.readFileSync(duplicate.archivePath, "utf8")).toBe(original);
      const recorded = readMigrationManifest(manifestPath);
      expect(recorded.restore?.consumedArchives ?? []).not.toContain(move.archivePath);
      expect(recorded.restore?.restoredFiles ?? []).not.toContain(move.sourcePath);
      const recordedTarget = expectDefined(recorded.targets[0], "recorded historical target");
      for (const moves of [recordedTarget.plannedMoves, recordedTarget.completedMoves]) {
        const recordedMove = expectDefined(
          moves.find((item) => item.archivePath === move.archivePath),
          "recorded historical original",
        );
        expect(recordedMove.artifact).toBeUndefined();
      }
      expect(fs.existsSync(target.sqlitePath)).toBe(false);
    },
  );

  it.each(
    ([1, 2] as const).flatMap((version) =>
      (["restore", "recover"] as const).map((retryMode) => ({ version, retryMode })),
    ),
  )(
    "retries historical v$version restored-directory edge sync through $retryMode",
    async ({ version, retryMode }) => {
      const { store, manifestPath, manifest } = createHistoricalRestoreStore(version);
      const target = expectDefined(manifest.targets[0], "historical restore target");
      const originals = target.plannedMoves.map((move) => ({
        ...move,
        bytes: fs.readFileSync(move.archivePath),
        identity: fs.statSync(move.archivePath, { bigint: true }),
      }));
      if (retryMode === "recover") {
        manifest.failedAt = manifest.startedAt;
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      }
      fs.rmdirSync(store.sessionDir);
      const sourceParent = path.dirname(store.sessionDir);
      const assertOriginalsRetained = () => {
        expect(readMigrationManifest(manifestPath).restore?.consumedArchives ?? []).toEqual([]);
        for (const original of originals) {
          expect(fs.readFileSync(original.archivePath)).toEqual(original.bytes);
          expect(fs.statSync(original.archivePath, { bigint: true }).ino).toBe(
            original.identity.ino,
          );
          if (fs.existsSync(original.sourcePath)) {
            expect(fs.readFileSync(original.sourcePath)).toEqual(original.bytes);
            expect(fs.statSync(original.sourcePath, { bigint: true }).ino).toBe(
              original.identity.ino,
            );
          }
        }
        for (const file of resolveSqliteDatabaseFilePaths(target.sqlitePath)) {
          expect(fs.existsSync(file)).toBe(false);
        }
      };
      const fsync = fs.fsyncSync;
      let edgeSyncAttempted = false;
      const syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (isDirectoryDescriptor(fd, sourceParent)) {
          edgeSyncAttempted = true;
          throw Object.assign(new Error("injected restored-directory edge sync"), { code: "EIO" });
        }
        fsync(fd);
      });
      try {
        const first = await runPublicSessionSqlite(store, "restore");
        expect(edgeSyncAttempted).toBe(true);
        expect(first.exitCode).toBe(1);
        expect(first.report.targets[0]?.restore?.conflicts).toEqual(
          expect.arrayContaining(
            originals.map(({ archivePath, sourcePath }) =>
              expect.objectContaining({ archivePath, sourcePath }),
            ),
          ),
        );
        expect(fs.statSync(store.sessionDir).isDirectory()).toBe(true);
        assertOriginalsRetained();

        edgeSyncAttempted = false;
        await expect(runPublicSessionSqlite(store, retryMode)).rejects.toThrow(
          "injected restored-directory edge sync",
        );
        expect(edgeSyncAttempted).toBe(true);
        assertOriginalsRetained();
      } finally {
        syncSpy.mockRestore();
      }
      const resumed = await runPublicSessionSqlite(store, retryMode);
      expect(resumed.report.targets[0]?.restore?.conflicts).toEqual([]);
      const consumed = readMigrationManifest(manifestPath).restore?.consumedArchives;
      expect(consumed).toHaveLength(originals.length);
      expect(consumed).toEqual(expect.arrayContaining(originals.map((move) => move.archivePath)));
      for (const original of originals) {
        expect(fs.readFileSync(original.sourcePath)).toEqual(original.bytes);
        expect(fs.statSync(original.sourcePath, { bigint: true }).ino).toBe(original.identity.ino);
        expect(fs.existsSync(original.archivePath)).toBe(false);
      }
      for (const file of resolveSqliteDatabaseFilePaths(target.sqlitePath)) {
        expect(fs.existsSync(file)).toBe(false);
      }
    },
  );

  it.each(
    ([1, 2] as const).flatMap((version) =>
      (
        [
          { phase: "metadata-write", retryMode: "restore" },
          { phase: "metadata-sync", retryMode: "restore" },
          { phase: "target-sync", retryMode: "recover" },
          { phase: "receipt-write", retryMode: "restore" },
          { phase: "receipt-sync", retryMode: "recover" },
          { phase: "archive-unlink", retryMode: "restore" },
          { phase: "archive-sync", retryMode: "recover" },
        ] as const
      ).map(({ phase, retryMode }) => ({ version, phase, retryMode })),
    ),
  )(
    "resumes historical v$version index restore after $phase through $retryMode",
    async ({ version, phase, retryMode }) => {
      const { store, manifestPath, manifest } = createHistoricalRestoreStore(version);
      const target = expectDefined(manifest.targets[0], "historical restore target");
      const index = expectDefined(
        target.plannedMoves.find((move) => move.kind === "legacy-store"),
        "historical index original",
      );
      const originals = target.plannedMoves.map((move) => ({
        ...move,
        bytes: fs.readFileSync(move.archivePath),
        identity: fs.statSync(move.archivePath, { bigint: true }),
      }));
      const indexOriginal = expectDefined(
        originals.find((item) => item.kind === "legacy-store"),
        "historical index bytes",
      );
      if (retryMode === "recover") {
        manifest.failedAt = manifest.startedAt;
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      }
      const manifestDir = path.dirname(manifestPath);
      const sourceDir = path.dirname(index.sourcePath);
      const archiveDir = path.dirname(index.archivePath);
      let injected = false;
      let replay = false;
      let failReplaySync = false;
      let replaySynced = false;
      let replayUnlinked = false;
      const hasReceipt = (candidate: SessionSqliteMigrationManifest) =>
        candidate.restore?.consumedArchives?.includes(index.archivePath) === true;
      const failManifestPhase = (
        candidate: SessionSqliteMigrationManifest,
        boundary: "write" | "sync",
      ) => {
        const recorded = candidate.targets
          .flatMap((item) => item.plannedMoves)
          .find((move) => move.archivePath === index.archivePath);
        const expectedPhase = hasReceipt(candidate)
          ? `receipt-${boundary}`
          : `metadata-${boundary}`;
        if (!injected && recorded?.artifact && phase === expectedPhase) {
          injected = true;
          throw new Error(`injected ${phase}`);
        }
      };
      const write = replaceFile.replaceFileAtomicSync;
      const writeSpy = vi
        .spyOn(replaceFile, "replaceFileAtomicSync")
        .mockImplementation((options) => {
          if (options.filePath === manifestPath) {
            failManifestPhase(
              JSON.parse(String(options.content)) as SessionSqliteMigrationManifest,
              "write",
            );
          }
          return write(options);
        });
      const fsync = fs.fsyncSync;
      const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (isDirectoryDescriptor(fd, manifestDir)) {
          failManifestPhase(readMigrationManifest(manifestPath), "sync");
        }
        fsync(fd);
      });
      const open = fsPromises.open;
      const restoreHandleSpies: Array<() => void> = [];
      const openSpy = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        if (phase === "target-sync" && String(args[0]) === sourceDir) {
          const sync = handle.sync.bind(handle);
          const handleSpy = vi.spyOn(handle, "sync").mockImplementation(async () => {
            if (!injected && fs.existsSync(index.sourcePath) && fs.existsSync(index.archivePath)) {
              injected = true;
              throw Object.assign(new Error("injected target-sync"), { code: "EIO" });
            }
            return sync();
          });
          restoreHandleSpies.push(() => handleSpy.mockRestore());
        }
        return handle;
      });
      const sync = directoryDurability.syncDirectory;
      const syncSpy = vi
        .spyOn(directoryDurability, "syncDirectory")
        .mockImplementation(async (directory, options) => {
          const syncingPath = typeof directory === "string" ? directory : directory.path;
          if (replay && syncingPath === sourceDir) {
            if (failReplaySync) {
              throw new Error("injected replay target-sync");
            }
            const result = await sync(directory, options);
            replaySynced = true;
            return result;
          }
          if (
            !injected &&
            phase === "archive-sync" &&
            syncingPath === archiveDir &&
            !fs.existsSync(index.archivePath)
          ) {
            injected = true;
            throw new Error("injected archive-sync");
          }
          return sync(directory, options);
        });
      const unlink = fs.unlinkSync;
      const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((file) => {
        if (String(file) === index.archivePath) {
          if (!injected && phase === "archive-unlink") {
            injected = true;
            throw new Error("injected archive-unlink");
          }
          if (replay) {
            expect(replaySynced).toBe(true);
            replayUnlinked = true;
          }
        }
        return unlink(file);
      });
      const copySpy = vi.spyOn(fs, "copyFileSync");
      const asyncCopySpy = vi.spyOn(fsPromises, "copyFile");
      try {
        const failed = await runPublicSessionSqlite(store, "restore");
        expect(injected).toBe(true);
        expect(failed.exitCode).toBe(1);
        expect(failed.report.targets[0]?.restore?.conflicts).toEqual(
          expect.arrayContaining([expect.objectContaining({ archivePath: index.archivePath })]),
        );
        const interrupted = readMigrationManifest(manifestPath);
        const consumedBeforeRetry = interrupted.restore?.consumedArchives ?? [];
        if (phase === "metadata-write" || phase === "metadata-sync") {
          expect(fs.existsSync(index.sourcePath)).toBe(false);
        } else {
          expect(fs.readFileSync(index.sourcePath)).toEqual(indexOriginal.bytes);
        }
        if (phase !== "archive-sync") {
          expect(fs.readFileSync(index.archivePath)).toEqual(indexOriginal.bytes);
        }
        if (phase === "archive-unlink" || phase === "archive-sync") {
          expect(consumedBeforeRetry).toContain(index.archivePath);
        }
        replay = fs.existsSync(index.sourcePath) && fs.existsSync(index.archivePath);
        if (phase === "target-sync") {
          failReplaySync = true;
          await expect(runPublicSessionSqlite(store, retryMode)).rejects.toThrow(
            "injected replay target-sync",
          );
          expect(fs.statSync(index.sourcePath).nlink).toBe(2);
          expect(fs.statSync(index.archivePath).ino).toBe(fs.statSync(index.sourcePath).ino);
          expect(replayUnlinked).toBe(false);
          failReplaySync = false;
        }
        const resumed = await runPublicSessionSqlite(store, retryMode);
        expect(resumed.report.targets[0]?.restore?.conflicts).toEqual([]);
        if (replay) {
          expect(replaySynced).toBe(true);
          expect(replayUnlinked).toBe(true);
        }
        replay = false;
        const settled = readMigrationManifest(manifestPath);
        expect(settled.manifestVersion).toBe(version);
        expect(settled.restore?.consumedArchives).toEqual(
          expect.arrayContaining(consumedBeforeRetry),
        );
        expect(settled.restore?.consumedArchives).toEqual(
          expect.arrayContaining(originals.map((item) => item.archivePath)),
        );
        for (const original of originals) {
          expect(fs.readFileSync(original.sourcePath)).toEqual(original.bytes);
          expect(fs.statSync(original.sourcePath, { bigint: true }).ino).toBe(
            original.identity.ino,
          );
          expect(fs.existsSync(original.archivePath)).toBe(false);
        }
        for (const file of resolveSqliteDatabaseFilePaths(target.sqlitePath)) {
          expect(fs.existsSync(file)).toBe(false);
        }
        expect(copySpy).not.toHaveBeenCalled();
        expect(asyncCopySpy).not.toHaveBeenCalled();
        expect((await runPublicSessionSqlite(store, "import")).report.totals.issues).toBe(0);
        expect(
          (await runPublicSessionSqlite(store, "restore")).report.targets[0]?.restore?.conflicts,
        ).toEqual([]);
        expect(readMigrationManifest(manifestPath).restore?.consumedArchives).toEqual(
          expect.arrayContaining(originals.map((item) => item.archivePath)),
        );
      } finally {
        writeSpy.mockRestore();
        fsyncSpy.mockRestore();
        openSpy.mockRestore();
        syncSpy.mockRestore();
        unlinkSpy.mockRestore();
        copySpy.mockRestore();
        asyncCopySpy.mockRestore();
        for (const restoreSpy of restoreHandleSpies) {
          restoreSpy();
        }
      }
    },
  );
});
