// File steps for the in-place state upgrade: the journaled swap of a fallback
// rebuild, generations and retention, and text normalization.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { copyFileDescriptorSync } from "@openclaw/fs-safe/advanced";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "../infra/disk-space.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { copySqliteFile } from "../infra/sqlite-file-copy.js";
import { prepareSqliteDatabaseDirectory } from "../infra/sqlite-wal-filesystem.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export type UpgradeOp = {
  /** Live path to replace, create or retire. */
  live: string;
  /** Prepared file to rename into place; absent for `remove`. */
  next?: string;
  kind: "replace" | "add" | "remove";
};

/** `appVersion` names the generation: the writing build's ID, or its version before build IDs. */
export type UpgradePlan = { appVersion: string; ops: UpgradeOp[] };

const PLAN_FILE = "plan.json";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");
// Copies an earlier upgrade or the retired in-place migration left behind.
const RETIRED_BACKUP_NAME =
  /\.pre-startup-migration-|\.scoped\.bak$|\.sqlite[^/]*\.bak$|^openclaw-media-persistence-recovery-/u;
const GENERATION_NAME = /\.pre-[^/]+$/u;
// SQLite companions the private copy folds in or the next open recreates.
const COMPANION_NAME = /-(wal|shm|journal)$|\.seal$/u;

export function fsyncPath(pathname: string, directory = false): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(pathname, directory ? "r" : "r+");
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows cannot open directories for fsync; the rename is still durable there.
    // SAFETY: node:fs and node:sqlite throw Error instances; only optional fields are read.
    const code = (error as NodeJS.ErrnoException).code;
    if (!(directory && (code === "EISDIR" || code === "EPERM" || code === "EACCES"))) {
      throw error;
    }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export function isSqliteFile(pathname: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(pathname, "r");
    const header = Buffer.alloc(SQLITE_HEADER.length);
    return (
      fs.readSync(fd, header, 0, header.length, 0) === header.length && header.equals(SQLITE_HEADER)
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

/** A consistent private copy that includes committed WAL frames; the source stays unwritten. */
/** Rows of a catalog or PRAGMA statement whose column list fixes the shape `T`. */
export function readSqliteRows<T>(db: DatabaseSync, sql: string): T[] {
  // SAFETY: callers pass a statement whose result columns match T.
  return db.prepare(sql).all() as T[];
}

export function vacuumSqliteInto(source: string, target: string): void {
  withRecoveredSource(source, (readable) => {
    fs.rmSync(target, { force: true });
    prepareSqliteDatabaseDirectory(target);
    const db = openNodeSqliteDatabase(readable, { readOnly: true });
    try {
      db.prepare("VACUUM INTO ?").run(target);
    } finally {
      db.close();
    }
  });
}

/**
 * Read a database that a crash left with a hot rollback journal. A read-only open
 * cannot roll it back, so the file and journal are copied and rolled back privately.
 */
export function withRecoveredSource<T>(pathname: string, read: (readable: string) => T): T {
  try {
    return read(pathname);
  } catch (error) {
    const journal = `${pathname}-journal`;
    if (!(fs.statSync(journal, { throwIfNoEntry: false })?.size ?? 0)) {
      throw error;
    }
    const bytes = fs.statSync(pathname).size + fs.statSync(journal).size;
    checkCopySpace(os.tmpdir(), bytes);
    const completed = reportCopy(bytes, 2);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-recover-"));
    try {
      const copy = path.join(dir, path.basename(pathname));
      prepareSqliteDatabaseDirectory(copy);
      for (const [source, target] of [
        [pathname, copy],
        [journal, `${copy}-journal`],
      ]) {
        const input = fs.openSync(source!, "r");
        try {
          const output = fs.openSync(target!, "w", 0o600);
          try {
            copyFileDescriptorSync(input, output);
          } finally {
            fs.closeSync(output);
          }
        } finally {
          fs.closeSync(input);
        }
      }
      completed();
      // The first read on a writable connection rolls the journal back.
      const db = openNodeSqliteDatabase(copy);
      try {
        db.prepare("SELECT count(*) FROM sqlite_master").get();
      } finally {
        db.close();
      }
      return read(copy);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

function skipEntry(name: string): boolean {
  return GENERATION_NAME.test(name) || RETIRED_BACKUP_NAME.test(name) || COMPANION_NAME.test(name);
}

const LARGE_COPY_BYTES = 256 * 1024 * 1024;

function checkCopySpace(volumePath: string, bytes: number): void {
  const volume = fs.statfsSync(volumePath, { bigint: true });
  const available = volume.bavail * volume.bsize;
  // Allow a second copy for migration scratch, and at least 256 MiB for journals.
  const margin = Math.max(bytes, LARGE_COPY_BYTES);
  if (available < BigInt(bytes + margin)) {
    throw Object.assign(
      new Error(
        `State upgrade copy needs ${bytes} bytes plus ${margin} bytes margin (${bytes + margin} bytes total); only ${available} bytes available. Free ${BigInt(bytes + margin) - available} bytes on ${volumePath} and start the Gateway again`,
      ),
      { code: "ENOSPC" },
    );
  }
}

function reportCopy(
  bytes: number,
  files: number,
  log?: { info: (message: string) => void },
): () => void {
  if (bytes < LARGE_COPY_BYTES) {
    return () => {};
  }
  const logger = log ?? createSubsystemLogger("state/upgrade");
  logger.info(`State upgrade copying ${bytes} bytes in ${files} files.`);
  const started = performance.now();
  return () => {
    const seconds = (performance.now() - started) / 1000;
    logger.info(
      `State upgrade copied ${bytes} bytes in ${files} files in ${seconds.toFixed(1)}s (${(bytes / seconds / 1e6).toFixed(1)} MB/s).`,
    );
  };
}

/** File names under a root, without generations, retired backups or SQLite companions. */
export function listFiles(
  root: string,
  skip: (absolute: string) => boolean,
  out = new Set<string>(),
) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const absolute = path.join(root, entry.name);
    if (skipEntry(entry.name) || skip(absolute)) {
      continue;
    }
    if (entry.isDirectory()) {
      listFiles(absolute, skip, out);
    } else {
      out.add(absolute);
    }
  }
  return out;
}

/** Old WAL, SHM, journal and seal files must never pair with a replaced database. */
export function companionRemovals(ops: readonly UpgradeOp[]): UpgradeOp[] {
  const removals: UpgradeOp[] = [];
  for (const op of ops) {
    if (op.kind !== "replace" || !op.next || !isSqliteFile(op.next)) {
      continue;
    }
    for (const suffix of ["-wal", "-journal", "-shm", ".seal"]) {
      if (fs.existsSync(`${op.live}${suffix}`)) {
        removals.push({ kind: "remove", live: `${op.live}${suffix}` });
      }
    }
  }
  return removals;
}

/** Durable intent: once this file exists, the next start rolls the swap forward. */
export function writePlan(workDir: string, plan: UpgradePlan): void {
  const file = path.join(workDir, PLAN_FILE);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(plan), { mode: 0o600 });
  fsyncPath(temp);
  fs.renameSync(temp, file);
  fsyncPath(workDir, true);
}

export function readPlan(workDir: string): UpgradePlan | undefined {
  try {
    // SAFETY: writePlan in this module is the only writer of the plan file.
    return JSON.parse(fs.readFileSync(path.join(workDir, PLAN_FILE), "utf8")) as UpgradePlan;
  } catch {
    return undefined;
  }
}

function isSymlinkAt(pathname: string): boolean {
  try {
    return fs.lstatSync(pathname).isSymbolicLink();
  } catch {
    return false;
  }
}

function preserve(live: string, preserved: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(live);
  } catch {
    return;
  }
  if (fs.existsSync(preserved) || isSymlinkAt(preserved)) {
    return;
  }
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(live), preserved);
  } else {
    // A hard link keeps the old bytes under the preserved name without a copy.
    fs.linkSync(live, preserved);
  }
}

/** Create missing live parents with the modes the chain gave them in the shadow, not the umask. */
function mkdirLike(live: string, shadow: string): void {
  if (fs.existsSync(live)) {
    return;
  }
  mkdirLike(path.dirname(live), path.dirname(shadow));
  fs.mkdirSync(live);
  fs.chmodSync(live, fs.statSync(shadow).mode & 0o7777);
}

/**
 * Apply a durable plan. Every step is idempotent, so a crash at any point is
 * finished by running this again with the same plan.
 */
export function applyPlan(plan: UpgradePlan): void {
  const directories = new Set<string>();
  // Retire old companions before any database name changes owner.
  const ordered = [
    ...plan.ops.filter((op) => op.kind === "remove"),
    ...plan.ops.filter((op) => op.kind !== "remove"),
  ];
  for (const op of ordered) {
    directories.add(path.dirname(op.live));
    // Shared-memory and seal files are rebuilt on open; they carry no data.
    if (op.kind !== "add" && !/-shm$|\.seal$/u.test(op.live)) {
      preserve(op.live, `${op.live}.pre-${plan.appVersion}`);
    }
    if (op.kind === "remove") {
      fs.rmSync(op.live, { force: true });
    } else if (op.next && (fs.existsSync(op.next) || isSymlinkAt(op.next))) {
      mkdirLike(path.dirname(op.live), path.dirname(op.next));
      fs.renameSync(op.next, op.live);
    }
  }
  for (const directory of directories) {
    fsyncPath(directory, true);
  }
}

/** Keep one prior generation of owned files only. Operator recovery is never pruned. */
export function pruneGenerations(
  root: string,
  keepVersion: string,
  pinnedVersions: ReadonlySet<string>,
  ownedFiles: ReadonlySet<string>,
): string[] {
  const removed: string[] = [];
  // No recursive walk: ownership comes from the copy or the durable swap plan.
  const directories = new Set([...ownedFiles].map((file) => path.dirname(file)));
  for (const directory of directories) {
    for (const name of fs.readdirSync(directory)) {
      // A generation is a build ID (custom IDs may start with a letter) or, before build IDs, a version.
      const match = /^(.*)\.pre-([^/]+)$/u.exec(name);
      if (!match || RETIRED_BACKUP_NAME.test(name)) {
        continue;
      }
      const [, original, generation] = match;
      const absolute = path.join(directory, name);
      if (
        ownedFiles.has(path.join(directory, original!)) &&
        generation !== keepVersion &&
        !pinnedVersions.has(generation!) &&
        fs.lstatSync(absolute).isFile()
      ) {
        fs.rmSync(absolute);
        removed.push(path.relative(root, absolute));
      }
    }
  }
  return removed;
}

/**
 * Decode BLOB values stored in TEXT columns (issue #110186) so shipped steps and
 * the rebuild see text. Runs under the start's custody, after the pre-migration image.
 */
export function normalizeSqliteText(db: DatabaseSync): void {
  // Keys change type in place; their parents and children are decoded in the same pass.
  db.exec("PRAGMA foreign_keys = OFF");
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'",
    )
    // SAFETY: the statement fixes the column names and types of each row.
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const columns = readSqliteRows<{ name: string; type: string; hidden: number }>(
      db,
      `PRAGMA table_xinfo(${quote(name)})`,
    );
    for (const column of columns) {
      // Declared BLOB and typeless columns may hold real bytes.
      if (column.hidden !== 0 || column.type === "" || /BLOB/iu.test(column.type)) {
        continue;
      }
      const c = quote(column.name);
      try {
        db.prepare(
          `UPDATE ${quote(name)} SET ${c} = CAST(${c} AS TEXT) WHERE typeof(${c}) = 'blob'`,
        ).run();
      } catch {
        // A constraint on the decoded value leaves the row for the copy to set aside.
      }
    }
  }
}

// The start's pre-migration images: taken under its exclusive custody before a database
// changes, and put back when the upgraded config is refused.

/** The error and every cause and aggregated error under it, each once. */
function causes(error: unknown): unknown[] {
  const found: unknown[] = [];
  const visit = (value: unknown) => {
    if (value === undefined || value === null || found.includes(value)) {
      return;
    }
    found.push(value);
    if (value instanceof AggregateError) {
      value.errors.forEach(visit);
    }
    if (value instanceof Error) {
      visit(value.cause);
    }
  };
  visit(error);
  return found;
}

/** A full disk or I/O failure, also when a copy or SQLite layer wraps it. */
export function isMachineFailure(error: unknown): boolean {
  return causes(error).some((cause) => {
    // SAFETY: node:fs and node:sqlite throw Error instances; only optional fields are read.
    const code = (cause as NodeJS.ErrnoException).code;
    const message = cause instanceof Error ? cause.message : "";
    return (
      code === "ENOSPC" ||
      code === "EIO" ||
      code === "EDQUOT" ||
      code === "EROFS" ||
      /SQLITE_FULL|database or disk is full|disk I\/O error/iu.test(message)
    );
  });
}

const PRE_IMAGE_RESERVE_BYTES = 64 * 1024 * 1024;

class PreImageSpaceError extends Error {}

/**
 * The pre-migration image of one outdated database, under the boot's exclusive custody:
 * a copy-on-write clone where the filesystem supports one, a byte copy only when the
 * copy still leaves the migration its room, otherwise none. Never a reason to refuse.
 */
export async function takeStateUpgradePreImage(
  file: string,
  suffix: string,
): Promise<{ path: string; method: "clone" | "copy" } | { skipped: string }> {
  const image = `${file}${suffix}`;
  const directory = path.dirname(file);
  for (const name of fs.readdirSync(directory)) {
    if (name.startsWith(`${path.basename(image)}.partial-`)) {
      // An interrupted copy; the database had not changed yet.
      fs.rmSync(path.join(directory, name), { force: true });
    }
  }
  // A same-named file left by an earlier, finished upgrade is not this run's baseline: the
  // new image replaces it by rename once it is complete, and until then it stays.
  // No writer runs: fold the WAL in so one file holds the whole database.
  const db = openNodeSqliteDatabase(file);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  for (const companion of ["-wal", "-journal"]) {
    if ((fs.statSync(`${file}${companion}`, { throwIfNoEntry: false })?.size ?? 0) > 0) {
      return { skipped: `its ${companion.slice(1)} could not be folded into the database` };
    }
  }
  const partial = `${image}.partial-${process.pid}`;
  let method: "clone" | "copy" = "clone";
  try {
    await copySqliteFile(file, partial, fs.lstatSync(file, { bigint: true }), {
      beforeByteCopy: (sizeBytes) => {
        method = "copy";
        // The copy must leave the migration its own room: about one database of WAL.
        const requiredBytes = 2 * sizeBytes + PRE_IMAGE_RESERVE_BYTES;
        const space = tryReadDiskSpace(directory);
        if (space && space.availableBytes < requiredBytes) {
          throw new PreImageSpaceError(
            `this filesystem cannot clone, and a copy needs ${formatDiskSpaceBytes(requiredBytes)} with the migration's room while ${formatDiskSpaceBytes(space.availableBytes)} is free`,
          );
        }
      },
    });
  } catch (error) {
    fs.rmSync(partial, { force: true });
    const space = causes(error).find((cause) => cause instanceof PreImageSpaceError);
    if (space instanceof PreImageSpaceError) {
      return { skipped: space.message };
    }
    if (isMachineFailure(error)) {
      // SAFETY: node:fs throws Error instances; only the message is read.
      return { skipped: `the disk filled while it was copied (${(error as Error).message})` };
    }
    throw error;
  }
  try {
    // A rollback-journal image needs no WAL or SHM companion, so reading it leaves none
    // behind; the first writer after a restore switches it back to WAL.
    const copy = openNodeSqliteDatabase(partial);
    try {
      copy.exec("PRAGMA journal_mode = DELETE");
    } finally {
      copy.close();
    }
    for (const companion of ["-wal", "-shm", "-journal"]) {
      fs.rmSync(`${partial}${companion}`, { force: true });
    }
    fsyncPath(partial);
    fs.renameSync(partial, image);
    fsyncPath(directory, true);
  } catch (error) {
    for (const companion of ["", "-wal", "-shm", "-journal"]) {
      fs.rmSync(`${partial}${companion}`, { force: true });
    }
    if (!isMachineFailure(error)) {
      throw error;
    }
    // SAFETY: node:fs and node:sqlite throw Error instances; only the message is read.
    return { skipped: `the disk filled while it was published (${(error as Error).message})` };
  }
  return { path: image, method };
}

/**
 * Doctor archives a legacy source it imported as `<file>.migrated` (or `.migrated.<n>`).
 * After the databases return to their images, put each archive this run created back
 * at its original name, which the previous release reads; never over a live file.
 */
export function restoreArchivedSources(
  before: ReadonlySet<string>,
  now: ReadonlySet<string>,
): void {
  for (const file of now) {
    const match = /^(.*)\.migrated(?:\.\d+)?$/u.exec(file);
    const original = match?.[1];
    if (original && !before.has(file) && before.has(original) && !fs.existsSync(original)) {
      fs.renameSync(file, original);
      fsyncPath(path.dirname(original), true);
    }
  }
}

/** Put pre-images back with no companion from the run left beside them. */
export function restorePreImages(files: readonly string[], suffix: string): void {
  for (const file of files) {
    if (!fs.existsSync(`${file}${suffix}`)) {
      continue;
    }
    for (const companion of ["-wal", "-journal", "-shm", ".seal"]) {
      fs.rmSync(`${file}${companion}`, { force: true });
    }
    fs.renameSync(`${file}${suffix}`, file);
    fsyncPath(path.dirname(file), true);
  }
}
