import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it, vi } from "vitest";
import { mockLargeDirectoryId } from "../../test/helpers/fs-large-directory-id.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import {
  cleanupBackupArchivePublication as cleanup,
  createBackupArchivePublication as create,
  publishPreparedBackupArchive as publish,
  type BackupArchivePublication,
} from "./backup-archive-publication.js";
import { writeArchiveStreamToFile } from "./backup-create-stream.js";
import { getPublishFileExclusiveFailureDetails } from "./directory-durability.js";

const tempDirs = createTempDirTracker();
const posix = process.platform !== "win32";
afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
  tempDirs.cleanup();
});

async function createPublication(outputDir = tempDirs.make("backup-publication-")) {
  const outputPath = path.join(outputDir, "backup.tar.gz");
  const plan = await create(outputPath);
  return { outputDir, outputPath, plan };
}

function output() {
  const outputDir = tempDirs.make("backup-publication-");
  return { outputDir, outputPath: path.join(outputDir, "backup.tar.gz") };
}

async function prepareArchive(plan: BackupArchivePublication, content = "complete archive") {
  return writeArchiveStreamToFile({
    archivePath: plan.tempArchivePath,
    createArchiveStream: () => Readable.from([content]),
    onPartialArchive: (receipt) => void plan.pendingCleanupArchives.push(receipt),
  });
}

async function setup(outputDir?: string) {
  const publication = await createPublication(outputDir);
  const prepared = await prepareArchive(publication.plan);
  const commit = (log?: (message: string) => void) =>
    publish({ plan: publication.plan, prepared, log });
  return { ...publication, prepared, commit };
}

async function expectMissing(filePath: string) {
  await expect(fs.lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectContents(filePath: string, content = "complete archive") {
  await expect(fs.readFile(filePath, "utf8")).resolves.toBe(content);
}

it.each(["file", ...(posix ? ["symlink"] : [])])(
  "refuses an existing %s before staging",
  async (kind) => {
    const { outputDir, outputPath } = output();
    await (kind === "file"
      ? fs.writeFile(outputPath, "keep")
      : fs.symlink("missing.tar.gz", outputPath));
    await expect(create(outputPath)).rejects.toThrow(
      "Refusing to overwrite existing backup archive:",
    );
    await (kind === "file"
      ? expectContents(outputPath, "keep")
      : expect(fs.readlink(outputPath)).resolves.toBe("missing.tar.gz"));
    await expect(fs.readdir(outputDir)).resolves.toEqual(["backup.tar.gz"]);
  },
);

it("propagates target inspection failures before creating staging", async () => {
  const { outputDir, outputPath } = output();
  const failure = Object.assign(new Error("target inspection failed"), { code: "EIO" });
  const lstat = fs.lstat.bind(fs);
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    if (path.basename(String(args[0])) === "backup.tar.gz") {
      throw failure;
    }
    return lstat(...args);
  });

  await expect(create(outputPath)).rejects.toBe(failure);
  await expect(fs.readdir(outputDir)).resolves.toEqual([]);
});

it("retires its prepared archive when cancellation precedes publication", async () => {
  const { outputDir, commit } = await setup();
  await expect(
    withCommandProcessScope(async (stop) => {
      stop();
      await commit();
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
  await expect(fs.readdir(outputDir)).resolves.toEqual([]);
});

it("publishes beneath a parent whose file ID exceeds Number's exact range", async () => {
  const outputDir = tempDirs.make("openclaw-backup-large-parent-id-");
  mockLargeDirectoryId(outputDir);
  const { outputPath, commit } = await setup(outputDir);
  await commit();

  await expectContents(outputPath);
  await expect(fs.readdir(outputDir)).resolves.toEqual(["backup.tar.gz"]);
});

it("removes its staging directory when private setup fails", async () => {
  const outputDir = tempDirs.make("openclaw-backup-setup-failure-");
  vi.spyOn(fs, "chmod").mockRejectedValue(
    Object.assign(new Error("chmod failed"), { code: "EIO" }),
  );
  await expect(createPublication(outputDir)).rejects.toThrow(/chmod failed/iu);
  await expect(fs.readdir(outputDir)).resolves.toEqual([]);
});

it("preserves a destination raced in before publication", async () => {
  const { outputPath, commit } = await setup();
  await fs.writeFile(outputPath, "racer", "utf8");

  await expect(commit()).rejects.toThrow(/Refusing to overwrite existing backup archive/iu);
  await expectContents(outputPath, "racer");
});

it.runIf(posix)("preserves a concurrently published hardlink", async () => {
  const { outputPath, prepared, commit } = await setup();
  await fs.link(prepared.archivePath, outputPath);

  await expect(commit()).rejects.toThrow(/Refusing to overwrite existing backup archive/iu);
  await expectContents(outputPath);
  await expectMissing(prepared.archivePath);
});

it("rejects a replaced staging pathname without publishing replacement bytes", async () => {
  const { outputPath, prepared, commit } = await setup();
  const originalPath = `${prepared.archivePath}.original`;
  await fs.rename(prepared.archivePath, originalPath);
  await fs.writeFile(prepared.archivePath, "replacement", "utf8");

  await expect(commit()).rejects.toThrow(/Backup archive changed during publication/iu);
  await expectMissing(outputPath);
  await expectContents(prepared.archivePath, "replacement");
});

it.runIf(posix)("pins the parent despite an output symlink retarget", async () => {
  const root = tempDirs.make("openclaw-backup-parent-retarget-");
  const firstDir = path.join(root, "first");
  const secondDir = path.join(root, "second");
  const requestedDir = path.join(root, "current");
  await fs.mkdir(firstDir);
  await fs.mkdir(secondDir);
  await fs.symlink(firstDir, requestedDir);
  const { commit } = await setup(requestedDir);
  await fs.unlink(requestedDir);
  await fs.symlink(secondDir, requestedDir);

  await expect(commit()).resolves.toBeUndefined();
  await expectContents(path.join(firstDir, "backup.tar.gz"));
  await expectMissing(path.join(secondDir, "backup.tar.gz"));
});

it.runIf(posix)("rejects canonical output-parent replacement", async () => {
  const { outputDir, outputPath, commit } = await setup();
  const movedOutputDir = `${outputDir}.moved`;
  await fs.rename(outputDir, movedOutputDir);
  await fs.mkdir(outputDir);

  await expect(commit()).rejects.toMatchObject({ code: "ENOENT" });
  await expectMissing(outputPath);
});

it.runIf(posix)("preserves committed bytes after directory sync failure", async () => {
  const code = "ENOTSUP";
  const { outputPath, plan, commit } = await setup();
  const log = vi.fn();
  const originalOpen = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
    const handle = await originalOpen(target, flags, mode);
    if (path.resolve(String(target)) === path.resolve(plan.canonicalParentPath)) {
      vi.spyOn(handle, "sync").mockRejectedValue(Object.assign(new Error("sync failed"), { code }));
    }
    return handle;
  });
  const error = await commit(log).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/sync failed/iu);
  expect(getPublishFileExclusiveFailureDetails(error)).toMatchObject({
    phase: "directory-sync",
    cleanup: "preserved",
    directorySync: { status: "failed", code },
  });
  await expectContents(outputPath);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("preserved the final archive"));
});

it("keeps the committed final archive when staging cleanup fails", async () => {
  const { outputPath, plan, prepared, commit } = await setup();
  const log = vi.fn();
  const originalUnlinkSync = fsSync.unlinkSync.bind(fsSync);
  const unlinkSpy = vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
    if (path.resolve(String(target)) === path.resolve(prepared.archivePath)) {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    }
    return originalUnlinkSync(target);
  });
  await expect(commit(log)).resolves.toBeUndefined();
  await expectContents(outputPath);
  expect(log).toHaveBeenCalledWith(
    `Backup archiver preserved changed staging file ${prepared.archivePath}.`,
  );
  unlinkSpy.mockRestore();
  await cleanup(plan);
  await expectMissing(prepared.archivePath);
  await expectMissing(plan.stagingDir);
});

it("retries cleanup when descriptor and pathname identity reads initially fail", async () => {
  const { plan } = await createPublication();
  const originalLstatSync = fsSync.lstatSync.bind(fsSync);
  const fstatSpy = vi.spyOn(fsSync, "fstatSync").mockImplementationOnce(() => {
    throw Object.assign(new Error("fstat failed"), { code: "EIO" });
  });
  let stagedLstatAttempts = 0;
  const lstatSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
    if (path.resolve(String(target)) === path.resolve(plan.tempArchivePath)) {
      stagedLstatAttempts += 1;
      if (stagedLstatAttempts === 1) {
        throw Object.assign(new Error("lstat failed"), { code: "EIO" });
      }
    }
    return originalLstatSync(target, options);
  });
  await expect(prepareArchive(plan, "partial archive")).rejects.toThrow("fstat failed");
  expect(plan.pendingCleanupArchives).toEqual([{ archivePath: plan.tempArchivePath }]);
  fstatSpy.mockRestore();
  lstatSpy.mockRestore();

  await cleanup(plan);
  await expectMissing(plan.tempArchivePath);
  await expectMissing(plan.stagingDir);
});

it("preserves a destination that replaces the linked archive before validation", async () => {
  const { outputPath, plan, commit } = await setup();
  const displacedPath = `${outputPath}.displaced`;
  __setFsSafeTestHooksForTest({
    afterPublishTargetCreated: async (_method, targetPath) => {
      if (path.resolve(targetPath) === path.resolve(plan.canonicalOutputPath)) {
        __setFsSafeTestHooksForTest(undefined);
        await fs.rename(plan.canonicalOutputPath, displacedPath);
        await fs.writeFile(plan.canonicalOutputPath, "racer", "utf8");
      }
    },
  });
  await expect(commit()).rejects.toThrow(/Backup archive changed during publication/iu);
  await expectContents(outputPath, "racer");
  await expectContents(displacedPath);
});

it("preserves a final-path replacement after the commit point", async () => {
  const { outputPath, plan, prepared, commit } = await setup();
  const displacedPath = `${outputPath}.displaced`;
  const unlink = fsSync.unlinkSync.bind(fsSync);
  let replaced = false;
  vi.spyOn(fsSync, "unlinkSync").mockImplementation((target) => {
    if (!replaced && path.resolve(String(target)) === path.resolve(prepared.archivePath)) {
      replaced = true;
      fsSync.renameSync(plan.canonicalOutputPath, displacedPath);
      fsSync.writeFileSync(plan.canonicalOutputPath, "racer", "utf8");
    }
    return unlink(target);
  });
  await expect(commit()).resolves.toBeUndefined();
  await expectContents(outputPath, "racer");
  await expectContents(displacedPath);
});
