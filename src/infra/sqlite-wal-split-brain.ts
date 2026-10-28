import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { hasErrnoCode } from "./errno.js";

const PROC_SELF_FD_PATH = "/proc/self/fd";
const SQLITE_WAL_SPLIT_BRAIN_FATAL_MESSAGE =
  "SQLite WAL sidecar identity mismatch; terminating without SQLite cleanup";

export type SqliteWalSplitBrainEvent = {
  event: "sqlite_wal_sidecar_identity_mismatch";
  databasePath: string;
  descriptorDevice: string;
  descriptorInode: string;
  sidecarPath: string;
  targetDevice?: string;
  targetInode?: string;
};

async function readUnlessMissing<T>(
  read: () => Promise<T>,
  allowClosedDescriptor = false,
): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if ((allowClosedDescriptor && hasErrnoCode(error, "EBADF")) || hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function isSqliteWalSidecarSplitBrain(
  descriptor: BigIntStats,
  target: BigIntStats | undefined,
): boolean {
  return (
    descriptor.nlink === 0n ||
    !target ||
    descriptor.dev !== target.dev ||
    descriptor.ino !== target.ino
  );
}

export async function detectSqliteWalSplitBrain(
  databasePath: string,
): Promise<SqliteWalSplitBrainEvent | undefined> {
  const descriptors = await readUnlessMissing(() => fs.promises.readdir(PROC_SELF_FD_PATH));
  const sidecarPaths = [`${databasePath}-wal`, `${databasePath}-shm`];
  for (const descriptorName of descriptors ?? []) {
    const descriptorPath = path.join(PROC_SELF_FD_PATH, descriptorName);
    const linkedPath = await readUnlessMissing(() => fs.promises.readlink(descriptorPath));
    if (linkedPath === undefined) {
      continue;
    }
    const sidecarPath = sidecarPaths.find(
      (candidate) => linkedPath === candidate || linkedPath === `${candidate} (deleted)`,
    );
    if (!sidecarPath) {
      continue;
    }
    const descriptor = await readUnlessMissing(
      () => promisify(fs.fstat)(Number(descriptorName), { bigint: true }),
      true,
    );
    if (
      descriptor === undefined ||
      (await readUnlessMissing(() => fs.promises.readlink(descriptorPath))) !== linkedPath
    ) {
      continue;
    }
    const target = await readUnlessMissing(() => fs.promises.stat(sidecarPath, { bigint: true }));
    if (!isSqliteWalSidecarSplitBrain(descriptor, target)) {
      continue;
    }
    // The async target lookup may outlive native close or reuse of this descriptor.
    const current = await readUnlessMissing(
      () => promisify(fs.fstat)(Number(descriptorName), { bigint: true }),
      true,
    );
    if (
      !current ||
      current.dev !== descriptor.dev ||
      current.ino !== descriptor.ino ||
      (await readUnlessMissing(() => fs.promises.readlink(descriptorPath))) !== linkedPath
    ) {
      continue;
    }
    return {
      event: "sqlite_wal_sidecar_identity_mismatch",
      databasePath,
      descriptorDevice: descriptor.dev.toString(),
      descriptorInode: descriptor.ino.toString(),
      sidecarPath,
      ...(target
        ? {
            targetDevice: target.dev.toString(),
            targetInode: target.ino.toString(),
          }
        : {}),
    };
  }
  return undefined;
}

export function terminateForSqliteWalSplitBrain(
  splitBrain: SqliteWalSplitBrainEvent,
  databaseLabel: string | undefined,
): never {
  try {
    // Worker stderr has no fd; write to the process sink before fatal containment.
    fs.writeSync(
      2,
      `${JSON.stringify({
        level: "fatal",
        subsystem: "infra/sqlite-wal",
        message: SQLITE_WAL_SPLIT_BRAIN_FATAL_MESSAGE,
        ...splitBrain,
        databaseLabel,
        pid: process.pid,
      })}\n`,
    );
  } catch {
    // Containment must proceed even when the diagnostic sink is unavailable.
  }
  // SIGKILL bypasses Node exit hooks that close SQLite caches. process.exit()
  // would re-enter the exact stale-handle cleanup this containment prevents.
  try {
    process.kill(process.pid, "SIGKILL");
  } finally {
    process.abort();
  }
}
