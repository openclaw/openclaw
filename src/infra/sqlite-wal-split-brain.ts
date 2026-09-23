import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
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

function statSqliteSidecarTarget(pathname: string): BigIntStats | undefined {
  try {
    return fs.statSync(pathname, { bigint: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
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

export function detectSqliteWalSplitBrain(
  databasePath: string,
): SqliteWalSplitBrainEvent | undefined {
  let descriptors: string[];
  try {
    descriptors = fs.readdirSync(PROC_SELF_FD_PATH);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  const sidecarPaths = [`${databasePath}-wal`, `${databasePath}-shm`];
  for (const descriptorName of descriptors) {
    const descriptorPath = path.join(PROC_SELF_FD_PATH, descriptorName);
    let linkedPath: string;
    try {
      linkedPath = fs.readlinkSync(descriptorPath);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    const sidecarPath = sidecarPaths.find(
      (candidate) => linkedPath === candidate || linkedPath === `${candidate} (deleted)`,
    );
    if (!sidecarPath) {
      continue;
    }
    let descriptor: BigIntStats;
    try {
      descriptor = fs.fstatSync(Number(descriptorName), { bigint: true });
    } catch (error) {
      if (hasErrnoCode(error, "EBADF") || hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    try {
      if (fs.readlinkSync(descriptorPath) !== linkedPath) {
        continue;
      }
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    const target = statSqliteSidecarTarget(sidecarPath);
    if (!isSqliteWalSidecarSplitBrain(descriptor, target)) {
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
