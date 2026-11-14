import fs from "node:fs";
import { sameFileIdentity, type FileIdentityStat } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sameFileMutationFingerprint, type FileMutationFingerprint } from "./file-descriptor.js";
import { hashPublishedFileSync, sameFileStatFingerprint } from "./sqlite-snapshot-file.js";

export function readSqliteIntegrityFileIdentity(
  pathname: string,
  expected?: FileIdentityStat,
): FileIdentityStat & { size: bigint } {
  const current = fs.statSync(pathname, { bigint: true });
  if (!current.isFile() || (expected && !sameFileIdentity(expected, current))) {
    throw new Error(`SQLite source changed during integrity admission: ${pathname}`);
  }
  return { dev: current.dev, ino: current.ino, size: current.size };
}

type SqliteFileFingerprint = FileMutationFingerprint & { sha256: string };

type SerializedSqliteFileFingerprint = Record<keyof SqliteFileFingerprint, string>;

export type SqliteFileGeneration = {
  database: SqliteFileFingerprint;
  journal?: SqliteFileFingerprint;
  wal?: SqliteFileFingerprint;
};

function canRetainDigest(stat: FileMutationFingerprint, observedAtNs: bigint): boolean {
  // Nanosecond fields can still describe a coarse filesystem clock. A digest
  // must start beyond the entire two-second timestamp quantum, including FAT.
  const cutoff = observedAtNs - 2_000_000_000n;
  return (
    typeof stat.dev === "bigint" &&
    typeof stat.ino === "bigint" &&
    typeof stat.size === "bigint" &&
    stat.dev !== 0n &&
    stat.ino !== 0n &&
    typeof stat.birthtimeNs === "bigint" &&
    typeof stat.mtimeNs === "bigint" &&
    typeof stat.ctimeNs === "bigint" &&
    stat.mtimeNs > 0n &&
    stat.ctimeNs > 0n &&
    stat.mtimeNs < cutoff &&
    stat.ctimeNs < cutoff
  );
}

function timestampNs(nanoseconds: bigint | undefined, milliseconds: bigint | number): bigint {
  return (
    nanoseconds ??
    (typeof milliseconds === "bigint"
      ? milliseconds * 1_000_000n
      : BigInt(Math.trunc(milliseconds * 1_000_000)))
  );
}

function fingerprintFile(
  pathname: string,
  verified: Map<string, SqliteFileFingerprint>,
): SqliteFileFingerprint {
  const observedAtNs = BigInt(Date.now()) * 1_000_000n;
  const fd = fs.openSync(pathname, "r");
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) {
      throw new Error("SQLite generation target must be a regular file");
    }
    const previous = verified.get(pathname);
    if (
      previous &&
      canRetainDigest(before, observedAtNs) &&
      sameFileMutationFingerprint(previous, before)
    ) {
      const after = fs.fstatSync(fd, { bigint: true });
      const current = fs.statSync(pathname, { bigint: true });
      if (
        current.isFile() &&
        sameFileMutationFingerprint(before, after) &&
        sameFileMutationFingerprint(after, current)
      ) {
        return previous;
      }
    }
    const { sha256 } = hashPublishedFileSync(fs.realpathSync.native(pathname), before);
    const after = fs.fstatSync(fd, { bigint: true });
    const current = fs.statSync(pathname, { bigint: true });
    if (!sameFileStatFingerprint(before, after) || !sameFileStatFingerprint(after, current)) {
      throw new Error(`SQLite generation target changed while hashing: ${pathname}`);
    }
    // Retain native descriptor IDs when Windows pathname stats report unknown IDs.
    const fingerprint = {
      birthtimeNs: timestampNs(after.birthtimeNs, after.birthtimeMs),
      ctimeNs: timestampNs(after.ctimeNs, after.ctimeMs),
      dev: after.dev,
      ino: after.ino,
      mtimeNs: timestampNs(after.mtimeNs, after.mtimeMs),
      sha256,
      size: after.size,
    };
    // Fresh, imprecise, or drifting timestamps cannot seed digest reuse, even
    // when hashing itself outlasted the timestamp quantum.
    if (
      canRetainDigest(before, observedAtNs) &&
      sameFileMutationFingerprint(before, after) &&
      sameFileMutationFingerprint(after, current)
    ) {
      verified.set(pathname, fingerprint);
    } else {
      verified.delete(pathname);
    }
    return fingerprint;
  } finally {
    fs.closeSync(fd);
  }
}

function readOptionalFile(
  pathname: string,
  verified: Map<string, SqliteFileFingerprint>,
): SqliteFileFingerprint | undefined {
  try {
    return fingerprintFile(pathname, verified);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      verified.delete(pathname);
      return undefined;
    }
    throw error;
  }
}

/** One observation owns its digests; every read still checks the complete family. */
export function createSqliteFileGenerationReader() {
  const verified = new Map<string, SqliteFileFingerprint>();
  return (pathname: string): SqliteFileGeneration => {
    const database = fingerprintFile(pathname, verified);
    const journal = readOptionalFile(`${pathname}-journal`, verified);
    const wal = readOptionalFile(`${pathname}-wal`, verified);
    return {
      database,
      ...(journal ? { journal } : {}),
      ...(wal ? { wal } : {}),
    };
  };
}

/** Raw source reads require an isolated process or a drained database owner. */
export function readStableSqliteFileGeneration(
  pathname: string,
  readGeneration = createSqliteFileGenerationReader(),
): SqliteFileGeneration {
  const first = readGeneration(pathname);
  const second = readGeneration(pathname);
  if (!sameSqliteFileGeneration(first, second)) {
    throw new Error(`SQLite file generation changed while reading: ${pathname}`);
  }
  return second;
}

function sameFileFingerprint(left: SqliteFileFingerprint, right: SqliteFileFingerprint): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    sameFileStatFingerprint(left, right) &&
    left.sha256 === right.sha256
  );
}

function sameOptionalFileFingerprint(
  left: SqliteFileFingerprint | undefined,
  right: SqliteFileFingerprint | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && sameFileFingerprint(left, right);
}

export function sameSqliteFileGeneration(
  left: SqliteFileGeneration,
  right: SqliteFileGeneration,
): boolean {
  return (
    sameFileFingerprint(left.database, right.database) &&
    sameOptionalFileFingerprint(left.journal, right.journal) &&
    // SQLite can create/delete an empty WAL while opening a closed reader; it contains no frames.
    sameOptionalFileFingerprint(
      left.wal?.size === 0n ? undefined : left.wal,
      right.wal?.size === 0n ? undefined : right.wal,
    )
  );
}

function serializeFileFingerprint(
  fingerprint: SqliteFileFingerprint,
): SerializedSqliteFileFingerprint {
  return {
    birthtimeNs: fingerprint.birthtimeNs.toString(),
    ctimeNs: fingerprint.ctimeNs.toString(),
    dev: fingerprint.dev.toString(),
    ino: fingerprint.ino.toString(),
    mtimeNs: fingerprint.mtimeNs.toString(),
    sha256: fingerprint.sha256,
    size: fingerprint.size.toString(),
  };
}

export function serializeSqliteFileGeneration(generation: SqliteFileGeneration): string {
  return JSON.stringify({
    database: serializeFileFingerprint(generation.database),
    ...(generation.journal ? { journal: serializeFileFingerprint(generation.journal) } : {}),
    ...(generation.wal ? { wal: serializeFileFingerprint(generation.wal) } : {}),
  });
}

function parseFileFingerprint(fingerprint: unknown): SqliteFileFingerprint {
  if (!isRecord(fingerprint)) {
    throw new Error("SQLite file fingerprint must be an object");
  }
  const fields = ["birthtimeNs", "ctimeNs", "dev", "ino", "mtimeNs", "size"] as const;
  for (const field of fields) {
    if (typeof fingerprint[field] !== "string" || !/^-?\d+$/u.test(fingerprint[field])) {
      throw new Error(`SQLite file fingerprint ${field} is invalid`);
    }
  }
  if (typeof fingerprint.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint.sha256)) {
    throw new Error("SQLite file fingerprint sha256 is invalid");
  }
  return {
    birthtimeNs: BigInt(fingerprint.birthtimeNs as string),
    ctimeNs: BigInt(fingerprint.ctimeNs as string),
    dev: BigInt(fingerprint.dev as string),
    ino: BigInt(fingerprint.ino as string),
    mtimeNs: BigInt(fingerprint.mtimeNs as string),
    sha256: fingerprint.sha256,
    size: BigInt(fingerprint.size as string),
  };
}

export function parseSqliteFileGeneration(serialized: string): SqliteFileGeneration {
  const generation: unknown = JSON.parse(serialized);
  if (!isRecord(generation)) {
    throw new Error("SQLite file generation must be an object");
  }
  return {
    database: parseFileFingerprint(generation.database),
    ...(generation.journal === undefined
      ? {}
      : { journal: parseFileFingerprint(generation.journal) }),
    ...(generation.wal === undefined ? {} : { wal: parseFileFingerprint(generation.wal) }),
  };
}
