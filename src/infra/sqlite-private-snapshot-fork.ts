import fs, { type BigIntStats } from "node:fs";
import path from "node:path";
import { openRootFileSync } from "@openclaw/fs-safe/advanced";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithSqliteCleanup, throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import {
  publishPreparedCopy,
  removeTempDirectoryAsync,
} from "./sqlite-readonly-location-cleanup.js";
import { copySourceFile, SqliteSourceChangedError } from "./sqlite-readonly-location.js";
import type { SqlitePrivateSnapshotFamily } from "./sqlite-readonly-location.types.js";
import {
  acquireSqliteSnapshotReadToken,
  createSqliteSnapshotStagingDirectorySync,
} from "./sqlite-snapshot-staging.js";

function fingerprint(file: BigIntStats): string {
  return [file.dev, file.ino, file.birthtimeNs, file.ctimeNs, file.mtimeNs, file.size].join(":");
}

function readFile(pathname: string): BigIntStats | undefined {
  const file = fs.lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
  if (!file) {
    return undefined;
  }
  if (!file.isFile() || file.nlink !== 1n) {
    throw new Error(`Private SQLite snapshot must be an independent regular file: ${pathname}`);
  }
  return file;
}

/** Only the retained read owner calls this, before lending its newly prepared image. */
export function captureSqlitePrivateSnapshotFamily(
  pathname: string,
  root: string,
): SqlitePrivateSnapshotFamily | undefined {
  if (fs.lstatSync(`${pathname}-journal`, { throwIfNoEntry: false })) {
    return undefined;
  }
  const main = readFile(pathname);
  const wal = readFile(`${pathname}-wal`);
  // SQLite ignores WALs no larger than its 32-byte header. Read-only opens can
  // create/remove these frame-free files without changing the owned main image.
  return main
    ? { root, main: fingerprint(main), wal: wal && wal.size > 32n ? fingerprint(wal) : null }
    : undefined;
}

export function readSqlitePrivateSnapshotFamily(value: unknown): SqlitePrivateSnapshotFamily {
  const isFingerprint = (entry: unknown): entry is string =>
    typeof entry === "string" && /^-?\d+(?::-?\d+){5}$/.test(entry);
  if (
    !isRecord(value) ||
    typeof value.root !== "string" ||
    !path.isAbsolute(value.root) ||
    !isFingerprint(value.main) ||
    (value.wal !== null && !isFingerprint(value.wal))
  ) {
    throw new Error("SQLite private fork requires its producer's captured family");
  }
  return { root: value.root, main: value.main, wal: value.wal };
}

/** Raw descriptors belong in the isolated child, never beside native SQLite handles. */
export async function forkSqlitePrivateSnapshotInProcess(
  pathname: string,
  family: SqlitePrivateSnapshotFamily,
  stagingRoot?: string,
) {
  const relative = path.relative(family.root, pathname);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("SQLite private fork source is outside its retained directory");
  }
  const releaseSource = acquireSqliteSnapshotReadToken(family.root);
  const files: Array<{ pathname: string; descriptor: number; expected: string }> = [];
  let directory: string | undefined;
  try {
    return runWithSqliteCleanup(
      {
        release() {
          const errors: unknown[] = [];
          for (const file of files) {
            try {
              fs.closeSync(file.descriptor);
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            releaseSource();
          } catch (error) {
            errors.push(error);
          }
          throwSqliteLifecycleErrors(errors, "Private SQLite fork source release failed");
        },
      },
      "Private SQLite snapshot fork",
      () => {
        const assertFamily = () => {
          const current = captureSqlitePrivateSnapshotFamily(pathname, family.root);
          if (current?.main !== family.main || current?.wal !== family.wal) {
            throw new SqliteSourceChangedError(`Retained SQLite snapshot changed: ${pathname}`);
          }
          for (const file of files) {
            if (fingerprint(fs.fstatSync(file.descriptor, { bigint: true })) !== file.expected) {
              throw new SqliteSourceChangedError(
                `Retained SQLite snapshot changed: ${file.pathname}`,
              );
            }
          }
        };
        assertFamily();
        for (const [suffix, expected] of [
          ["", family.main],
          ["-wal", family.wal],
        ] as const) {
          if (expected === null) {
            continue;
          }
          const sourcePath = `${pathname}${suffix}`;
          const opened = openRootFileSync({
            rootPath: family.root,
            absolutePath: sourcePath,
            boundaryLabel: "retained SQLite snapshot",
          });
          if (!opened.ok) {
            throw new Error(`Cannot open retained SQLite snapshot: ${sourcePath}`, {
              cause: opened.error,
            });
          }
          files.push({ pathname: sourcePath, descriptor: opened.fd, expected });
        }
        assertFamily();
        directory = createSqliteSnapshotStagingDirectorySync(stagingRoot);
        const destination = path.join(directory, "database.sqlite.partial");
        for (const file of files) {
          const identity = fs.fstatSync(file.descriptor, { bigint: true });
          copySourceFile(file.pathname, `${destination}${file.pathname.slice(pathname.length)}`, {
            key: `file:${identity.dev}:${identity.ino}`,
          });
        }
        // Read-only owners cannot commit main changes, but SQLite close can alter
        // WAL files. Refuse committed-family drift; never drop frames or recapture live state.
        assertFamily();
        return publishPreparedCopy(directory);
      },
    );
  } catch (error) {
    const errors: unknown[] = [error];
    if (
      directory &&
      !(await removeTempDirectoryAsync(directory, (failure) => errors.push(failure)))
    ) {
      errors.push(new Error(`Private SQLite fork cleanup failed: ${directory}`));
    }
    throwSqliteLifecycleErrors(errors, "Private SQLite fork and cleanup failed");
    throw error;
  }
}
