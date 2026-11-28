import fs from "node:fs";
import asyncFs from "node:fs/promises";
import path from "node:path";
import * as replaceFile from "@openclaw/fs-safe/atomic";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import * as durability from "../infra/directory-durability.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import {
  contains,
  containsObjects,
  expectFiles,
  expectMissing,
  expectOriginal,
  writeManifest,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import { createCompetingRestoreTarget } from "./doctor-session-sqlite.publication.test-support.js";
import {
  runPublicSessionSqlite as runPublic,
  isDirectoryDescriptor,
  readMigrationManifest as readManifest,
  type SessionSqliteMigrationManifest as Manifest,
  useDoctorSessionSqliteTestFixture,
} from "./doctor-session-sqlite.test-support.js";

vi.mock("@openclaw/fs-safe/atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/atomic")>()),
}));

const { createHistoricalRestoreStore, createVerifiedRecoveryStore } =
  useDoctorSessionSqliteTestFixture();

type PublicResult = Awaited<ReturnType<typeof runPublic>>;
function conflicts(result: PublicResult) {
  return result.report.targets[0]?.restore?.conflicts;
}
function originalMoves(target: Manifest["targets"][number]) {
  return target.plannedMoves.map((move) => ({
    ...move,
    bytes: fs.readFileSync(move.archivePath),
    identity: fs.statSync(move.archivePath, { bigint: true }),
  }));
}
function expectRestored(originals: ReturnType<typeof originalMoves>, sqlitePath: string) {
  for (const original of originals) {
    expectOriginal(original.sourcePath, original.bytes, original.identity.ino);
    expectMissing(original.archivePath);
  }
  expectMissing(...resolveSqliteDatabaseFilePaths(sqlitePath));
}

function historicalFixture(version: 1 | 2, interrupted = false) {
  const fixture = createHistoricalRestoreStore(version);
  const { manifest, manifestPath, store } = fixture;
  const target = expectDefined(manifest.targets[0], "historical restore target");
  if (interrupted) {
    manifest.failedAt = manifest.startedAt;
    writeManifest(manifestPath, manifest);
  }
  const originals = originalMoves(target);
  return {
    ...fixture,
    target,
    originals,
    move: (kind: string) =>
      expectDefined(
        target.plannedMoves.find((move) => move.kind === kind),
        kind,
      ),
    run: (mode: Parameters<typeof runPublic>[1]) => runPublic(store, mode),
    read: () => readManifest(manifestPath),
  };
}

it.each([
  { interrupted: false, changed: false },
  { interrupted: false, changed: true },
  { interrupted: true, changed: false },
  { interrupted: true, changed: true },
])(
  "checks retained receipts after a device change (interrupted=$interrupted, changed=$changed)",
  async ({ interrupted, changed }) => {
    const { store, imported, archivePath } = await createVerifiedRecoveryStore();
    const manifestPath = expectDefined(imported.migrationRun?.manifestPath, "migration receipt");
    const original = fs.readFileSync(archivePath, "utf8");
    const originalIdentity = fs.statSync(archivePath, { bigint: true });
    if (interrupted) {
      const unlink = fs.unlinkSync;
      using unlinkSpy = vi.spyOn(fs, "unlinkSync");
      unlinkSpy.mockImplementation((file) => {
        if (String(file) === archivePath) {
          throw new Error("injected restore interruption");
        }
        return unlink(file);
      });
      const first = await runPublic(store, "restore");
      expect(conflicts(first)).toEqual([
        expect.objectContaining({ archivePath, reason: "injected restore interruption" }),
      ]);
      expect(fs.statSync(archivePath).nlink).toBe(2);
    }
    const manifest = readManifest(manifestPath);
    for (const target of manifest.targets) {
      for (const move of [...target.plannedMoves, ...target.completedMoves]) {
        if (move.archivePath !== archivePath) {
          continue;
        }
        const artifact = expectDefined(move.artifact, "recorded original identity");
        artifact.identity.dev = String(BigInt(artifact.identity.dev) + 1n);
      }
    }
    writeManifest(manifestPath, manifest);
    const retainedTargets = structuredClone(manifest.targets);
    const content = changed ? original.replace("preserved history", "different history") : original;
    if (changed) {
      expect(content).not.toBe(original);
      fs.writeFileSync(archivePath, content);
    }

    if (interrupted && changed) {
      await expect(runPublic(store, "restore")).rejects.toThrow(/changed/);
    } else {
      const result = await runPublic(store, "restore");
      expect(conflicts(result)).toEqual(
        changed
          ? [expect.objectContaining({ archivePath, reason: expect.stringContaining("changed") })]
          : [],
      );
      expect(result.exitCode).toBe(changed ? 1 : 0);
    }
    const recorded = readManifest(manifestPath);
    expect(recorded.targets).toEqual(retainedTargets);
    if (changed) {
      expectFiles(content, archivePath);
      expect(fs.existsSync(store.transcriptPath)).toBe(interrupted);
    } else {
      expectFiles(original, store.transcriptPath);
      const restored = fs.statSync(store.transcriptPath, { bigint: true });
      expect(restored).toMatchObject({ ino: originalIdentity.ino, nlink: 1n });
      expectMissing(archivePath);
      expect(recorded.restore?.consumedArchives).toContain(archivePath);
    }
  },
);

it.each(
  (
    [
      { version: 1, destination: "file" },
      { version: 2, destination: "dangling-symlink" },
    ] as const
  ).filter(({ destination }) => destination === "file" || process.platform !== "win32"),
)(
  "preserves a late-created $destination during historical v$version restore without SQLite",
  async ({ version, destination }) => {
    const { store, manifest, archivePath, run, read, move } = historicalFixture(version);
    const original = fs.readFileSync(archivePath);
    const { sourcePath } = move("transcript");
    const competitorPath = path.join(store.tempDir, "competing-writer.jsonl");
    const competitorContent = "history written by a separate process\n";
    if (destination === "file") {
      fs.writeFileSync(competitorPath, competitorContent, { mode: 0o600 });
    }
    let competitorIdentity: fs.BigIntStats | undefined;
    const publish = durability.publishFileExclusive;
    using publicationSpy = vi
      .spyOn(durability, "publishFileExclusive")
      .mockImplementation(async (options) => {
        if (
          !competitorIdentity &&
          options.sourcePath === archivePath &&
          options.targetPath === sourcePath
        ) {
          competitorIdentity = createCompetingRestoreTarget(
            destination,
            competitorPath,
            sourcePath,
          );
        }
        return publish(options);
      });
    const result = await run("restore");
    publicationSpy.mockRestore();
    const created = expectDefined(competitorIdentity, "separate writer ran at publication");
    const retained = fs.lstatSync(sourcePath, { bigint: true });
    expect(retained).toMatchObject({ ino: created.ino, dev: created.dev });
    if (destination === "file") {
      expectFiles(competitorContent, sourcePath);
    } else {
      expect(retained.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(sourcePath)).toBe(competitorPath);
      expectMissing(competitorPath);
    }
    expectFiles(original, archivePath);
    expect(result.exitCode).toBe(1);
    const restored = read().restore;
    containsObjects(restored?.conflicts, { archivePath, sourcePath });
    expect(restored?.consumedArchives ?? []).not.toContain(archivePath);
    expect(restored?.restoredFiles ?? []).not.toContain(sourcePath);
    expectMissing(...manifest.targets.map((target) => target.sqlitePath));
  },
);

it("rejects a changed historical v1 transcript before adopting restore metadata", async () => {
  const { manifestPath, manifest, target, run, read, move: findMove } = historicalFixture(1);
  const move = findMove("transcript");
  const original = fs.readFileSync(move.archivePath, "utf8");
  const changed = original.replace('"session-1"', '"session-2"');
  expect(changed).not.toBe(original);
  expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
  const identity = fs.statSync(move.archivePath, { bigint: true });
  const duplicate = { ...move, archivePath: `${move.archivePath}.duplicate` };
  fs.copyFileSync(move.archivePath, duplicate.archivePath);
  target.plannedMoves.push(duplicate);
  target.completedMoves.push({ ...duplicate });
  writeManifest(manifestPath, manifest);

  const close = fs.closeSync;
  let injected = false;
  using closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
    const opened = fs.fstatSync(fd, { bigint: true });
    close(fd);
    if (!injected && opened.dev === identity.dev && opened.ino === identity.ino) {
      // Change real bytes after the planner closes its verified descriptor, before adoption.
      injected = true;
      fs.writeFileSync(move.archivePath, changed);
    }
  });
  const result = await run("restore");
  closeSpy.mockRestore();
  expect(injected).toBe(true);
  expect(result.exitCode).toBe(1);
  expect(conflicts(result)).toEqual([
    {
      archivePath: move.archivePath,
      sourcePath: move.sourcePath,
      reason: "archive changed after restore planning; refusing restore",
    },
  ]);
  expectMissing(move.sourcePath);
  expectFiles(changed, move.archivePath);
  expect(fs.statSync(move.archivePath, { bigint: true }).ino).toBe(identity.ino);
  expectFiles(original, duplicate.archivePath);
  const recorded = read();
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
  expectMissing(target.sqlitePath);
});

it("retries historical v2 restored-directory edge sync through recover", async () => {
  const { store, target, originals, run, read } = historicalFixture(2, true);
  fs.rmdirSync(store.sessionDir);
  const sourceParent = path.dirname(store.sessionDir);
  const assertOriginalsRetained = () => {
    expect(read().restore?.consumedArchives ?? []).toEqual([]);
    for (const original of originals) {
      expectOriginal(original.archivePath, original.bytes, original.identity.ino);
      if (fs.existsSync(original.sourcePath)) {
        expectOriginal(original.sourcePath, original.bytes, original.identity.ino);
      }
    }
    expectMissing(...resolveSqliteDatabaseFilePaths(target.sqlitePath));
  };
  const fsync = fs.fsyncSync;
  let edgeSyncAttempted = false;
  using syncSpy = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    if (isDirectoryDescriptor(fd, sourceParent)) {
      edgeSyncAttempted = true;
      throw Object.assign(new Error("injected restored-directory edge sync"), { code: "EIO" });
    }
    fsync(fd);
  });
  const first = await run("restore");
  expect(edgeSyncAttempted).toBe(true);
  expect(first.exitCode).toBe(1);
  containsObjects(
    conflicts(first),
    ...originals.map(({ archivePath, sourcePath }) => ({ archivePath, sourcePath })),
  );
  expect(fs.statSync(store.sessionDir).isDirectory()).toBe(true);
  assertOriginalsRetained();

  edgeSyncAttempted = false;
  await expect(run("recover")).rejects.toThrow("injected restored-directory edge sync");
  expect(edgeSyncAttempted).toBe(true);
  assertOriginalsRetained();
  syncSpy.mockRestore();
  const resumed = await run("recover");
  expect(conflicts(resumed)).toEqual([]);
  const consumed = read().restore?.consumedArchives;
  expect(consumed).toHaveLength(originals.length);
  contains(consumed, ...originals.map((move) => move.archivePath));
  expectRestored(originals, target.sqlitePath);
});

it.each([
  { version: 1, phase: "metadata-write", retryMode: "restore" },
  { version: 2, phase: "metadata-sync", retryMode: "restore" },
  { version: 1, phase: "target-sync", retryMode: "recover" },
  { version: 2, phase: "receipt-write", retryMode: "restore" },
  { version: 1, phase: "receipt-sync", retryMode: "recover" },
  { version: 1, phase: "archive-sync", retryMode: "recover" },
] as const)(
  "resumes historical v$version index restore after $phase through $retryMode",
  async ({ version, phase, retryMode }) => {
    const { manifestPath, target, originals, run, read } = historicalFixture(
      version,
      retryMode === "recover",
    );
    const index = expectDefined(
      originals.find((item) => item.kind === "legacy-store"),
      "historical index bytes",
    );
    const manifestDir = path.dirname(manifestPath);
    const sourceDir = path.dirname(index.sourcePath);
    const archiveDir = path.dirname(index.archivePath);
    let injected = false;
    let replay = false;
    let failReplaySync = false;
    let replaySynced = false;
    let replayUnlinked = false;
    const hasReceipt = (candidate: Manifest) =>
      candidate.restore?.consumedArchives?.includes(index.archivePath) === true;
    const failManifestPhase = (candidate: Manifest, boundary: "write" | "sync") => {
      const recorded = candidate.targets
        .flatMap((item) => item.plannedMoves)
        .find((move) => move.archivePath === index.archivePath);
      const expectedPhase = hasReceipt(candidate) ? `receipt-${boundary}` : `metadata-${boundary}`;
      if (!injected && recorded?.artifact && phase === expectedPhase) {
        injected = true;
        throw new Error(`injected ${phase}`);
      }
    };
    const write = replaceFile.replaceFileAtomicSync;
    using writeSpy = vi.spyOn(replaceFile, "replaceFileAtomicSync");
    writeSpy.mockImplementation((options) => {
      if (options.filePath === manifestPath) {
        failManifestPhase(JSON.parse(String(options.content)) as Manifest, "write");
      }
      return write(options);
    });
    const fsync = fs.fsyncSync;
    using fsyncSpy = vi.spyOn(fs, "fsyncSync");
    fsyncSpy.mockImplementation((fd) => {
      if (isDirectoryDescriptor(fd, manifestDir)) {
        failManifestPhase(read(), "sync");
      }
      fsync(fd);
    });
    const open = asyncFs.open;
    const handleSpies: Array<{ mockRestore(): void }> = [];
    using handles = {
      spies: handleSpies,
      [Symbol.dispose]() {
        for (const spy of this.spies) {
          spy.mockRestore();
        }
      },
    };
    using openSpy = vi.spyOn(asyncFs, "open");
    openSpy.mockImplementation(async (...args) => {
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
        handles.spies.push(handleSpy);
      }
      return handle;
    });
    const sync = durability.syncDirectory;
    using syncSpy = vi.spyOn(durability, "syncDirectory");
    syncSpy.mockImplementation(async (directory, options) => {
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
    using unlinkSpy = vi.spyOn(fs, "unlinkSync");
    unlinkSpy.mockImplementation((file) => {
      if (String(file) === index.archivePath && replay) {
        expect(replaySynced).toBe(true);
        replayUnlinked = true;
      }
      return unlink(file);
    });
    using copySpy = vi.spyOn(fs, "copyFileSync");
    using asyncCopySpy = vi.spyOn(asyncFs, "copyFile");
    const failed = await run("restore");
    expect(injected).toBe(true);
    expect(failed.exitCode).toBe(1);
    containsObjects(conflicts(failed), { archivePath: index.archivePath });
    const interrupted = read();
    const consumedBeforeRetry = interrupted.restore?.consumedArchives ?? [];
    if (phase === "metadata-write" || phase === "metadata-sync") {
      expectMissing(index.sourcePath);
    } else {
      expectFiles(index.bytes, index.sourcePath);
    }
    if (phase !== "archive-sync") {
      expectFiles(index.bytes, index.archivePath);
    }
    if (phase === "archive-sync") {
      expect(consumedBeforeRetry).toContain(index.archivePath);
    }
    replay = fs.existsSync(index.sourcePath) && fs.existsSync(index.archivePath);
    if (phase === "target-sync") {
      failReplaySync = true;
      await expect(run(retryMode)).rejects.toThrow("injected replay target-sync");
      expect(fs.statSync(index.sourcePath).nlink).toBe(2);
      expect(fs.statSync(index.archivePath).ino).toBe(fs.statSync(index.sourcePath).ino);
      expect(replayUnlinked).toBe(false);
      failReplaySync = false;
    }
    const resumed = await run(retryMode);
    expect(conflicts(resumed)).toEqual([]);
    if (replay) {
      expect(replaySynced).toBe(true);
      expect(replayUnlinked).toBe(true);
    }
    replay = false;
    const settled = read();
    expect(settled.manifestVersion).toBe(version);
    contains(settled.restore?.consumedArchives, ...consumedBeforeRetry);
    contains(settled.restore?.consumedArchives, ...originals.map((item) => item.archivePath));
    expectRestored(originals, target.sqlitePath);
    expect(copySpy).not.toHaveBeenCalled();
    expect(asyncCopySpy).not.toHaveBeenCalled();
    expect((await run("import")).report.totals.issues).toBe(0);
    expect(conflicts(await run("restore"))).toEqual([]);
    contains(read().restore?.consumedArchives, ...originals.map((item) => item.archivePath));
  },
);
