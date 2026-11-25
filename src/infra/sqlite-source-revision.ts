// Raw source descriptors belong only to an isolated child or a drained source owner.
import { createHash } from "node:crypto";
import fs, { type BigIntStats } from "node:fs";
import { hasErrnoCode } from "./errno.js";

const suffixes = ["", "-wal", "-journal"] as const;

function stat(pathname: string): BigIntStats | undefined {
  try {
    const value = fs.statSync(pathname, { bigint: true });
    if (!value.isFile()) {
      throw new Error(`SQLite source is not a regular file: ${pathname}`);
    }
    return value;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function identity(value: BigIntStats | undefined): string {
  return value
    ? [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":")
    : "missing";
}

/** A new full byte observation, not a timestamp cache or an admission decision.
 * SHM is derived coordination data; committed rows depend on DB/WAL/journal bytes.
 * Never call in a writer process: closing even a raw descriptor can release that
 * process's SQLite POSIX locks. The snapshot owner selects child/drained execution.
 */
export function readSqliteSourceContentVersionInProcess(pathname: string): string | undefined {
  const canonical = fs.realpathSync.native(pathname);
  const before = suffixes.map((suffix) => stat(canonical + suffix));
  if (!before[0]) {
    return undefined;
  }
  const hash = createHash("sha256").update(canonical);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (const [index, suffix] of suffixes.entries()) {
    const expected = before[index];
    hash.update(`\0${suffix}\0${identity(expected)}\0`);
    if (!expected) {
      continue;
    }
    let descriptor: number;
    try {
      descriptor = fs.openSync(canonical + suffix, "r");
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
    try {
      if (identity(fs.fstatSync(descriptor, { bigint: true })) !== identity(expected)) {
        return undefined;
      }
      let remaining = expected.size;
      while (remaining > 0n) {
        const length = Number(
          remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining,
        );
        const count = fs.readSync(descriptor, buffer, 0, length, null);
        if (count === 0) {
          return undefined;
        }
        hash.update(buffer.subarray(0, count));
        remaining -= BigInt(count);
      }
      if (identity(fs.fstatSync(descriptor, { bigint: true })) !== identity(expected)) {
        return undefined;
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }
  if (
    fs.realpathSync.native(pathname) !== canonical ||
    suffixes.some((suffix, index) => identity(stat(canonical + suffix)) !== identity(before[index]))
  ) {
    return undefined;
  }
  return hash.digest("hex");
}
