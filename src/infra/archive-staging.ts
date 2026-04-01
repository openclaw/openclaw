import fs from "node:fs/promises";
import path from "node:path";
import { copyFileWithinRoot } from "./fs-safe.js";
import { isNotFoundPathError, isPathInside } from "./path-guards.js";

const ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK = "archive entry traverses symlink in destination";

export type ArchiveSecurityErrorCode =
  | "destination-not-directory"
  | "destination-symlink"
  | "destination-symlink-traversal";

export class ArchiveSecurityError extends Error {
  code: ArchiveSecurityErrorCode;

  constructor(code: ArchiveSecurityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "ArchiveSecurityError";
  }
}

function symlinkTraversalError(originalPath: string): ArchiveSecurityError {
  return new ArchiveSecurityError(
    "destination-symlink-traversal",
    `${ERROR_ARCHIVE_ENTRY_TRAVERSES_SYMLINK}: ${originalPath}`,
  );
}

export async function prepareArchiveDestinationDir(destDir: string): Promise<string> {
  const stat = await fs.lstat(destDir);
  if (stat.isSymbolicLink()) {
    throw new ArchiveSecurityError("destination-symlink", "archive destination is a symlink");
  }
  if (!stat.isDirectory()) {
    throw new ArchiveSecurityError(
      "destination-not-directory",
      "archive destination is not a directory",
    );
  }
  return await fs.realpath(destDir);
}

async function assertNoSymlinkTraversal(params: {
  rootDir: string;
  relPath: string;
  originalPath: string;
}): Promise<void> {
  const parts = params.relPath.split(/[\\/]+/).filter(Boolean);
  let current = path.resolve(params.rootDir);
  for (const part of parts) {
    current = path.join(current, part);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (err) {
      if (isNotFoundPathError(err)) {
        continue;
      }
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw symlinkTraversalError(params.originalPath);
    }
  }
}

async function assertResolvedInsideDestination(params: {
  destinationRealDir: string;
  targetPath: string;
  originalPath: string;
}): Promise<void> {
  let resolved: string;
  try {
    resolved = await fs.realpath(params.targetPath);
  } catch (err) {
    if (isNotFoundPathError(err)) {
      return;
    }
    throw err;
  }
  if (!isPathInside(params.destinationRealDir, resolved)) {
    throw symlinkTraversalError(params.originalPath);
  }
}

export async function prepareArchiveOutputPath(params: {
  destinationDir: string;
  destinationRealDir: string;
  relPath: string;
  outPath: string;
  originalPath: string;
  isDirectory: boolean;
}): Promise<void> {
  await assertNoSymlinkTraversal({
    rootDir: params.destinationDir,
    relPath: params.relPath,
    originalPath: params.originalPath,
  });

  if (params.isDirectory) {
    await fs.mkdir(params.outPath, { recursive: true });
    await assertResolvedInsideDestination({
      destinationRealDir: params.destinationRealDir,
      targetPath: params.outPath,
      originalPath: params.originalPath,
    });
    return;
  }

  const parentDir = path.dirname(params.outPath);
  await fs.mkdir(parentDir, { recursive: true });
  await assertResolvedInsideDestination({
    destinationRealDir: params.destinationRealDir,
    targetPath: parentDir,
    originalPath: params.originalPath,
  });
}

async function applyStagedEntryMode(params: {
  destinationRealDir: string;
  relPath: string;
  mode: number;
  originalPath: string;
  isDirectory?: boolean;
}): Promise<void> {
  const destinationPath = path.join(params.destinationRealDir, params.relPath);
  await assertResolvedInsideDestination({
    destinationRealDir: params.destinationRealDir,
    targetPath: destinationPath,
    originalPath: params.originalPath,
  });
  if (params.isDirectory && params.mode === 0) {
    return;
  }
  await fs.chmod(destinationPath, params.mode).catch(() => undefined);
}

export async function withStagedArchiveDestination<T>(params: {
  destinationRealDir: string;
  run: (stagingDir: string) => Promise<T>;
}): Promise<T> {
  const stagingDir = await fs.mkdtemp(path.join(params.destinationRealDir, ".openclaw-archive-"));
  try {
    return await params.run(stagingDir);
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function copyStagedFileIntoDestination(params: {
  sourcePath: string;
  destinationRealDir: string;
  relPath: string;
  originalPath: string;
  sourceMode: number;
}): Promise<void> {
  const restoreMode = params.sourceMode & 0o777;
  const readableMode = restoreMode | 0o400;
  const shouldTemporarilyRelaxSourceRead = (restoreMode & 0o400) === 0;

  if (shouldTemporarilyRelaxSourceRead) {
    await fs.chmod(params.sourcePath, readableMode);
  }

  try {
    await copyFileWithinRoot({
      sourcePath: params.sourcePath,
      rootDir: params.destinationRealDir,
      relativePath: params.relPath,
      mkdir: true,
      createMode: restoreMode | 0o600,
    });
  } catch (error) {
    throw new Error(`archive staging could not merge ${params.originalPath}`, {
      cause: error,
    });
  } finally {
    if (shouldTemporarilyRelaxSourceRead) {
      await fs.chmod(params.sourcePath, restoreMode).catch(() => {});
    }
  }
}

export async function mergeExtractedTreeIntoDestination(params: {
  sourceDir: string;
  destinationDir: string;
  destinationRealDir: string;
}): Promise<void> {
  const walk = async (currentSourceDir: string): Promise<void> => {
    const entries = await fs.readdir(currentSourceDir, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(currentSourceDir, entry.name);
      const relPath = path.relative(params.sourceDir, sourcePath);
      const originalPath = relPath.split(path.sep).join("/");
      const destinationPath = path.join(params.destinationDir, relPath);
      const sourceStat = await fs.lstat(sourcePath);

      if (sourceStat.isSymbolicLink()) {
        throw symlinkTraversalError(originalPath);
      }

      if (sourceStat.isDirectory()) {
        await prepareArchiveOutputPath({
          destinationDir: params.destinationDir,
          destinationRealDir: params.destinationRealDir,
          relPath,
          outPath: destinationPath,
          originalPath,
          isDirectory: true,
        });
        await walk(sourcePath);
        await applyStagedEntryMode({
          destinationRealDir: params.destinationRealDir,
          relPath,
          mode: sourceStat.mode & 0o777,
          originalPath,
          isDirectory: true,
        });
        continue;
      }

      if (!sourceStat.isFile()) {
        throw new Error(`archive staging contains unsupported entry: ${originalPath}`);
      }

      await prepareArchiveOutputPath({
        destinationDir: params.destinationDir,
        destinationRealDir: params.destinationRealDir,
        relPath,
        outPath: destinationPath,
        originalPath,
        isDirectory: false,
      });
      const sourceMode = sourceStat.mode & 0o777;
      await copyStagedFileIntoDestination({
        sourcePath,
        destinationRealDir: params.destinationRealDir,
        relPath,
        originalPath,
        sourceMode,
      });
      await applyStagedEntryMode({
        destinationRealDir: params.destinationRealDir,
        relPath,
        mode: sourceMode,
        originalPath,
      });
    }
  };

  await walk(params.sourceDir);
}

export function createArchiveSymlinkTraversalError(originalPath: string): ArchiveSecurityError {
  return symlinkTraversalError(originalPath);
}
