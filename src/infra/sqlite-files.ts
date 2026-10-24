import { spawnSync } from "node:child_process";
import fs from "node:fs";
import type { BigIntStats } from "node:fs";
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

const SQLITE_HEADER_PROBE_TIMEOUT_MS = 10_000;
const SQLITE_HEADER_PROBE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const SQLITE_HEADER_PROBE_CACHE_MAX_ENTRIES = 8_192;

// Closing a raw descriptor also releases every POSIX record lock this process
// holds on the same inode, so an in-process probe would silently drop the locks
// of live SQLite connections, including canonical databases reached through
// alternative-name hardlinks. The probe therefore runs in a short-lived child
// process whose descriptor close can only affect its own lock-free descriptors.
// The child also computes each candidate's stat identity: the parent must not
// lstat candidates at all, because backup classification runs per archived
// entry and the archive-walk ratchets bound per-file lstat probes during a
// capture. Missing, unreadable, symlinked, or non-regular files are reported
// without an identity and as not SQLite.
const SQLITE_HEADER_PROBE_SCRIPT = `
const fs = require("node:fs");
const magic = Buffer.from("SQLite format 3\\0", "utf8");
const results = {};
for (const pathname of JSON.parse(fs.readFileSync(0, "utf8"))) {
  results[pathname] = { identity: null, sqlite: false };
  try {
    const stat = fs.lstatSync(pathname, { bigint: true });
    if (!stat.isFile()) {
      continue;
    }
    results[pathname].identity = stat.dev + ":" + stat.ino + ":" + stat.size + ":" + stat.mtimeNs;
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const descriptor = fs.openSync(pathname, flags);
    try {
      if (fs.fstatSync(descriptor).isFile()) {
        const header = Buffer.alloc(magic.length);
        const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
        results[pathname].sqlite = bytesRead === header.length && header.equals(magic);
      }
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    results[pathname] = { identity: null, sqlite: false };
  }
}
process.stdout.write(JSON.stringify(results));
`;

const sqliteHeaderProbeResults = new Map<string, boolean>();
// Capture-scoped retention: backup discovery and archive traversal classify
// the same non-`.sqlite` candidates, and a state tree can hold far more of
// them than the cross-backup cache above. While a capture is active, probe
// results also land here so eviction from the bounded cache can never degrade
// classification into one child process per file. The map is dropped when the
// capture ends.
const retainedSqliteHeaderProbeResults = new Map<string, boolean>();
// Capture-scoped per-path answers. Classification during a capture must not
// lstat candidates at all (the archive walk ratchets per-file lstat probes),
// so a capture freezes each probed path's answer at discovery time — the same
// capture-scoped classification semantics the name-trusted `.sqlite` policy
// already has. Keyed by the resolved main-database path.
const retainedSqliteHeaderProbePaths = new Map<string, boolean>();
let sqliteHeaderProbeRetentionDepth = 0;
let sqliteHeaderProbeChildCount = 0;
let sqliteHeaderProbeFailureInjected = false;
// Test seam: when set, this text is prepended to the real child's stdout so
// the decoding boundary sees exactly what an inherited preload printing to
// stdout would produce — the real child still runs and the real parser still
// decodes the corrupted payload.
let sqliteHeaderProbeStdoutNoiseForTest: string | undefined;

function sqliteHeaderProbeIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

function rememberSqliteHeaderProbeResult(identity: string, result: boolean): void {
  if (sqliteHeaderProbeRetentionDepth > 0) {
    retainedSqliteHeaderProbeResults.set(identity, result);
  }
  if (sqliteHeaderProbeResults.size >= SQLITE_HEADER_PROBE_CACHE_MAX_ENTRIES) {
    // FIFO eviction: the oldest entry leaves. Results for the current capture
    // stay readable through the retention map, so eviction only bounds
    // cross-capture reuse instead of discarding a whole warmed batch.
    const oldestIdentity = sqliteHeaderProbeResults.keys().next().value;
    if (oldestIdentity !== undefined) {
      sqliteHeaderProbeResults.delete(oldestIdentity);
    }
  }
  sqliteHeaderProbeResults.set(identity, result);
}

/** Decoded per-path answer; `identity: null` covers non-regular or missing files. */
type SqliteHeaderProbeAnswer = { identity: string | null; sqlite: boolean };

/** Decoded per-path answers; `undefined` means the stdout was undecodable. */
function parseSqliteHeaderProbeResults(
  stdout: string,
): Map<string, SqliteHeaderProbeAnswer> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const results = new Map<string, SqliteHeaderProbeAnswer>();
  for (const [pathname, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const identity: unknown = value.identity;
    const sqlite: unknown = value.sqlite;
    if ((identity === null || typeof identity === "string") && typeof sqlite === "boolean") {
      results.set(pathname, { identity, sqlite });
    }
  }
  return results;
}

/** Isolated header-probe outcome: `ok: false` means the child could not answer at all. */
type SqliteHeaderProbeOutcome =
  | { ok: true; results: Map<string, SqliteHeaderProbeAnswer> }
  | { ok: false; reason: string };

function probeSqliteDatabaseHeadersInChild(pathnames: readonly string[]): SqliteHeaderProbeOutcome {
  if (pathnames.length === 0) {
    return { ok: true, results: new Map() };
  }
  sqliteHeaderProbeChildCount += 1;
  if (sqliteHeaderProbeFailureInjected) {
    return { ok: false, reason: "header probe failure injected by a test" };
  }
  const executable = resolveNodeRuntimeExecutable();
  if (!executable) {
    return { ok: false, reason: "no Node.js runtime executable could be resolved" };
  }
  try {
    const result = spawnSync(executable, ["-e", SQLITE_HEADER_PROBE_SCRIPT], {
      input: JSON.stringify(pathnames),
      encoding: "utf8",
      maxBuffer: SQLITE_HEADER_PROBE_MAX_BUFFER_BYTES,
      timeout: SQLITE_HEADER_PROBE_TIMEOUT_MS,
    });
    if (result.error) {
      return { ok: false, reason: result.error.message };
    }
    if (result.status !== 0) {
      const stderrDetail = result.stderr?.trim();
      return {
        ok: false,
        reason: stderrDetail
          ? `probe child exited with status ${result.status}: ${stderrDetail}`
          : `probe child exited with status ${result.status}`,
      };
    }
    // Exit status 0 is not an answer on its own: a preload or shim printing
    // to stdout can corrupt the payload, and treating that as an empty (all
    // negative) result would cache false for every candidate.
    const stdout = sqliteHeaderProbeStdoutNoiseForTest
      ? `${sqliteHeaderProbeStdoutNoiseForTest}${result.stdout}`
      : result.stdout;
    const results = parseSqliteHeaderProbeResults(stdout);
    if (results === undefined) {
      return { ok: false, reason: "probe child produced undecodable stdout" };
    }
    return { ok: true, results };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Thrown when the isolated header probe cannot answer for a candidate. */
class SqliteHeaderProbeError extends Error {
  constructor(pathname: string, reason: string) {
    super(
      `Could not determine whether ${pathname} is a SQLite database: the isolated header-probe child process failed (${reason}). ` +
        "Refusing to guess: a wrong answer would either skip the verified snapshot or silence the opaque-copy warning. " +
        "Check that a Node.js runtime can run, then retry the backup.",
    );
    this.name = "SqliteHeaderProbeError";
  }
}

/**
 * Reports whether the regular file at `pathname` carries the SQLite database
 * header magic. Names alone never classify a file as a database: missing,
 * unreadable, symlinked, or non-regular files are reported as false. The header
 * bytes are read in a separate process so this process never opens (and later
 * closes) a raw descriptor that could release live SQLite POSIX locks.
 *
 * During a backup capture, discovery batches every walked candidate through
 * {@link prefetchSqliteDatabaseHeaders} and the per-path answers are retained
 * for the whole capture, so repeated classification (a second discovery pass,
 * the archive walk) reuses them without touching the filesystem: a capture
 * freezes each candidate's answer at discovery time, mirroring how the
 * name-trusted `.sqlite` policy fixes classification by name for the whole
 * capture.
 *
 * Outside a capture — or for a path discovery never probed — the answer is
 * computed on demand: an in-process lstat derives the stat identity, warm
 * cache answers are reused, and otherwise a child process reads the header.
 * A child that fails outright (spawn error, timeout, malformed output) is an
 * unknown result, not a negative one: guessing "not a database" would let a
 * live database be archived as ordinary bytes with no warning, so the failure
 * is retried once per path and then surfaced as {@link SqliteHeaderProbeError}.
 * Unknown results are never cached.
 */
export function hasSqliteDatabaseHeader(pathname: string): boolean {
  if (sqliteHeaderProbeRetentionDepth > 0) {
    const retainedPath = retainedSqliteHeaderProbePaths.get(pathname);
    if (retainedPath !== undefined) {
      return retainedPath;
    }
  }
  const stat = fs.lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isFile()) {
    return false;
  }
  const identity = sqliteHeaderProbeIdentity(stat);
  const retained = retainedSqliteHeaderProbeResults.get(identity);
  if (retained !== undefined) {
    return retained;
  }
  const cached = sqliteHeaderProbeResults.get(identity);
  if (cached !== undefined) {
    return cached;
  }
  const outcome = probeSqliteDatabaseHeadersInChild([pathname]);
  if (!outcome.ok) {
    throw new SqliteHeaderProbeError(pathname, outcome.reason);
  }
  const answer = outcome.results.get(pathname);
  if (answer === undefined) {
    // A successful child run must still answer for the requested path; a
    // missing answer is unknown, not a negative result.
    throw new SqliteHeaderProbeError(pathname, "the probe child returned no answer for this path");
  }
  rememberSqliteHeaderProbeResult(identity, answer.sqlite);
  return answer.sqlite;
}

/**
 * Retains header-probe results for the duration of a backup capture. Backup
 * discovery and archive traversal classify the same candidates; retaining
 * every batched result keeps large state trees on a single child process
 * even when the candidate count exceeds the cross-backup cache cap. Safe to
 * nest; every begin must be matched by one end.
 */
export function beginSqliteHeaderProbeRetention(): void {
  sqliteHeaderProbeRetentionDepth += 1;
}

/** Drops capture-scoped header-probe retention started by the matching begin. */
export function endSqliteHeaderProbeRetention(): void {
  sqliteHeaderProbeRetentionDepth = Math.max(0, sqliteHeaderProbeRetentionDepth - 1);
  if (sqliteHeaderProbeRetentionDepth === 0) {
    retainedSqliteHeaderProbeResults.clear();
    retainedSqliteHeaderProbePaths.clear();
  }
}

/**
 * Warms the header probe answers for many candidates with a single child
 * process so backup discovery classifies a whole state tree without paying a
 * process spawn per file — and without touching the candidates from this
 * process at all: the child derives each candidate's stat identity and reads
 * its header, keeping per-file lstat probes out of the capture's archive walk.
 * Answers are retained for the whole capture so a second discovery pass and
 * the archive traversal reuse them. Only definite results are cached: when the
 * child fails outright (spawn error, timeout, malformed output) every candidate
 * stays unknown and uncached, so per-path classification retries and surfaces
 * the failure instead of silently declaring those files non-SQLite.
 */
export function prefetchSqliteDatabaseHeaders(pathnames: Iterable<string>): void {
  const pending = new Set<string>();
  for (const pathname of pathnames) {
    if (retainedSqliteHeaderProbePaths.has(pathname) || pending.has(pathname)) {
      continue;
    }
    pending.add(pathname);
  }
  if (pending.size === 0) {
    return;
  }
  const outcome = probeSqliteDatabaseHeadersInChild([...pending]);
  if (!outcome.ok) {
    return;
  }
  for (const [pathname, answer] of outcome.results) {
    if (sqliteHeaderProbeRetentionDepth > 0) {
      retainedSqliteHeaderProbePaths.set(pathname, answer.sqlite);
    }
    if (answer.identity !== null) {
      rememberSqliteHeaderProbeResult(answer.identity, answer.sqlite);
    }
  }
}

/** @internal Test seam: clears probe caches, retention, counters, and failure injection. */
export function resetSqliteHeaderProbeForTest(): void {
  sqliteHeaderProbeResults.clear();
  retainedSqliteHeaderProbeResults.clear();
  retainedSqliteHeaderProbePaths.clear();
  sqliteHeaderProbeRetentionDepth = 0;
  sqliteHeaderProbeChildCount = 0;
  sqliteHeaderProbeFailureInjected = false;
  sqliteHeaderProbeStdoutNoiseForTest = undefined;
}

/** @internal Test seam: how many child processes have been spawned for header probes. */
export function sqliteHeaderProbeChildCountForTest(): number {
  return sqliteHeaderProbeChildCount;
}

/**
 * @internal Test seam: force every header-probe child to fail, so fail-closed
 * classification (retry, then surface) can be exercised deterministically.
 */
export function failSqliteHeaderProbesForTest(enabled: boolean): void {
  sqliteHeaderProbeFailureInjected = enabled;
}

/**
 * @internal Test seam: prepend noise to every real child's stdout, so the
 * decoding boundary sees exactly what an inherited preload printing to stdout
 * would produce — undecodable output must be unknown, never a cached negative.
 */
export function corruptSqliteHeaderProbeStdoutForTest(noise: string | undefined): void {
  sqliteHeaderProbeStdoutNoiseForTest = noise;
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
