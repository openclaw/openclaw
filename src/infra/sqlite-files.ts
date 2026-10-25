import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { openRootFileSync } from "./boundary-file-read.js";
import { sha256FileSync } from "./crypto-digest.js";
import { resolveNodeRuntimeExecutable } from "./node-runtime-executable.js";

/** SQLite main database plus every journal-mode sidecar that can contain database pages. */
const SQLITE_DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;
export const SQLITE_SIDECAR_SUFFIXES = SQLITE_DATABASE_FILE_SUFFIXES.slice(1);
// SQLite WAL format: https://sqlite.org/fileformat2.html#walformat defines a 32-byte header.
const SQLITE_WAL_HEADER_BYTES = 32;
const APPLE_DOUBLE_MAGIC = Buffer.from([0x00, 0x05, 0x16, 0x07]);

/** AppleDouble files start with 00 05 16 07; the `._*.sqlite` name alone is not enough. */
export function isAppleDoubleMetadataFile(pathname: string): boolean {
  const basename = path.basename(pathname);
  if (!basename.startsWith("._") || !basename.endsWith(".sqlite")) {
    return false;
  }
  const opened = openRootFileSync({
    absolutePath: pathname,
    rootPath: path.dirname(pathname),
    boundaryLabel: "SQLite metadata directory",
    rejectHardlinks: false,
  });
  if (!opened.ok) {
    return false;
  }
  try {
    const header = Buffer.alloc(APPLE_DOUBLE_MAGIC.length);
    const bytesRead = fs.readSync(opened.fd, header, 0, header.length, 0);
    return bytesRead === header.length && header.equals(APPLE_DOUBLE_MAGIC);
  } catch {
    return false;
  } finally {
    fs.closeSync(opened.fd);
  }
}

const sqliteFilesLog = createSubsystemLogger("state/sqlite");

// A raw descriptor closed here could release another SQLite connection's POSIX
// locks on the same inode. Probe in a child that owns no database connections.
const SQLITE_HEADER_PROBE_SCRIPT = `
const fs = require("node:fs");
const magic = Buffer.from("SQLite format 3\\0");
const results = JSON.parse(fs.readFileSync(0, "utf8")).map((pathname) => {
  try {
    if (!fs.lstatSync(pathname).isFile()) return false;
    const fd = fs.openSync(pathname, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      if (!fs.fstatSync(fd).isFile()) return false;
      const header = Buffer.alloc(magic.length);
      return fs.readSync(fd, header, 0, header.length, 0) === header.length && header.equals(magic);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ELOOP") return false;
    throw error;
  }
});
process.stdout.write(JSON.stringify(results));
`;

/** Probe one discovery batch without disturbing live SQLite file locks. */
export function probeSqliteDatabaseHeaders(pathnames: Iterable<string>): Map<string, boolean> {
  const paths = [...new Set(pathnames)];
  if (paths.length === 0) {
    return new Map();
  }
  try {
    const executable = resolveNodeRuntimeExecutable();
    if (!executable) {
      throw new Error("No Node.js runtime executable could be resolved");
    }
    const result = childProcess.spawnSync(executable, ["-e", SQLITE_HEADER_PROBE_SCRIPT], {
      input: JSON.stringify(paths),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10_000,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`Header probe exited with status ${result.status}: ${result.stderr.trim()}`);
    }
    const answers: unknown = JSON.parse(result.stdout);
    if (
      !Array.isArray(answers) ||
      answers.length !== paths.length ||
      !answers.every((answer): answer is boolean => typeof answer === "boolean")
    ) {
      throw new Error("Header probe returned an incomplete result");
    }
    return new Map(paths.map((pathname, index) => [pathname, answers[index]!]));
  } catch (cause) {
    throw new Error(
      "Could not determine whether backup files are SQLite databases. " +
        "Check that Node.js can run and the source files are readable, then retry the backup.",
      { cause },
    );
  }
}

class SqliteOrphanedSidecarsError extends Error {
  constructor(pathname: string, sidecarPaths: string[], cause: unknown) {
    super(
      `SQLite database is missing at ${pathname}, and orphaned sidecars could not be copied: ${sidecarPaths.join(", ")}. ` +
        "Refusing to open because SQLite could delete orphan WAL or journal state. Preserve the sidecar bytes, restore the main database, and pair it with the matching sidecar before retrying.",
      { cause },
    );
    this.name = "SqliteOrphanedSidecarsError";
  }
}

type CopiedSqliteSidecar = {
  quarantinePath: string;
  sourcePath: string;
};

/** Resolves the main database and all possible journal-mode sidecar paths. */
export function resolveSqliteDatabaseFilePaths(pathname: string): string[] {
  return SQLITE_DATABASE_FILE_SUFFIXES.map((suffix) => `${pathname}${suffix}`);
}

export function hasOrphanedSqliteSidecars(pathname: string): boolean {
  return (
    !fs.existsSync(pathname) &&
    SQLITE_SIDECAR_SUFFIXES.some((suffix) => fs.existsSync(`${pathname}${suffix}`))
  );
}

function findMatchingOrphanedSidecarCopy(
  sourcePath: string,
  sourceSize: number,
): string | undefined {
  const directory = path.dirname(sourcePath);
  const prefix = `${path.basename(sourcePath)}.orphaned-`;
  const candidates = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => path.join(directory, entry.name))
    .filter((candidate) => fs.statSync(candidate).size === sourceSize);
  if (candidates.length === 0) {
    return undefined;
  }
  const sourceHash = sha256FileSync(sourcePath);
  for (const candidate of candidates) {
    if (sha256FileSync(candidate) === sourceHash) {
      return candidate;
    }
  }
  return undefined;
}

function copyOrphanedSidecar(sourcePath: string, epochMs: number): string {
  const basePath = `${sourcePath}.orphaned-${epochMs}`;
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? basePath : `${basePath}-${suffix}`;
    try {
      fs.copyFileSync(sourcePath, candidate, fs.constants.COPYFILE_EXCL);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }
}

/** Preserve durable orphan sidecars before SQLite creates a replacement main database. */
export function quarantineOrphanedSqliteSidecars(pathname: string): void {
  if (fs.existsSync(pathname)) {
    return;
  }
  const sidecars = [
    { path: `${pathname}-wal`, minimumBytes: SQLITE_WAL_HEADER_BYTES },
    { path: `${pathname}-journal`, minimumBytes: 0 },
  ].flatMap((sidecar) => {
    const stat = fs.statSync(sidecar.path, { throwIfNoEntry: false });
    return stat?.isFile() === true && stat.size > sidecar.minimumBytes
      ? [{ path: sidecar.path, size: stat.size }]
      : [];
  });
  if (sidecars.length === 0) {
    return;
  }

  const epochMs = Date.now();
  const copied: CopiedSqliteSidecar[] = [];
  try {
    for (const sidecar of sidecars) {
      if (findMatchingOrphanedSidecarCopy(sidecar.path, sidecar.size)) {
        continue;
      }
      const quarantinePath = copyOrphanedSidecar(sidecar.path, epochMs);
      copied.push({ quarantinePath, sourcePath: sidecar.path });
    }
  } catch (error) {
    throw new SqliteOrphanedSidecarsError(
      pathname,
      sidecars.map((sidecar) => sidecar.path),
      error,
    );
  }
  if (copied.length === 0) {
    return;
  }

  const copies = copied.map(
    ({ sourcePath, quarantinePath }) => `${sourcePath} -> ${quarantinePath}`,
  );
  sqliteFilesLog.warn(
    `SQLite database is missing at ${pathname}; copied orphaned sidecars: ${copies.join(", ")}. ` +
      "Committed frames could not be applied because the main database is missing. The bytes are preserved. Recovery requires restoring the main database and pairing it with the quarantined file.",
    {
      databasePath: pathname,
      copiedSidecars: copied,
    },
  );
}
