// File steps for the copy-and-swap state upgrade: private copy, diff, journaled
// swap and retention. Nothing here writes a live file before the plan is durable.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";

export type UpgradeOp = {
  /** Live path to replace, create or retire. */
  live: string;
  /** Prepared file to rename into place; absent for `remove`. */
  next?: string;
  kind: "replace" | "add" | "remove";
};

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

export function preservedPath(live: string, appVersion: string): string {
  return `${live}.pre-${appVersion}`;
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
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-recover-"));
    try {
      const copy = path.join(dir, path.basename(pathname));
      fs.copyFileSync(pathname, copy);
      fs.copyFileSync(journal, `${copy}-journal`);
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

/**
 * Copy the live tree into `shadow`. SQLite files get a consistent read-only copy,
 * other files a copy-on-write clone where the filesystem supports it.
 */
export function copyTree(
  live: string,
  shadow: string,
  skip: (absolute: string) => boolean,
  visited = new Set<string>([fs.realpathSync(live)]),
): void {
  fs.mkdirSync(shadow, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(live, { withFileTypes: true })) {
    const source = path.join(live, entry.name);
    const target = path.join(shadow, entry.name);
    if (skipEntry(entry.name) || skip(source)) {
      continue;
    }
    // A symlink is copied as what it points to, so nothing written to the private
    // copy can reach the live file. A dangling link stays a link.
    const linked = entry.isSymbolicLink() ? fs.statSync(source, { throwIfNoEntry: false }) : null;
    if (entry.isDirectory() || linked?.isDirectory()) {
      const real = fs.realpathSync(source);
      if (!visited.has(real)) {
        copyTree(source, target, skip, new Set([...visited, real]));
      }
    } else if (entry.isSymbolicLink() && !linked) {
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else if (entry.isFile() || linked?.isFile()) {
      if (isSqliteFile(source)) {
        vacuumSqliteInto(source, target);
      } else {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
      }
      fs.chmodSync(target, fs.statSync(source).mode & 0o7777);
    }
  }
}

function sameContent(a: string, b: string): boolean {
  if (fs.lstatSync(a).isSymbolicLink() && fs.lstatSync(b).isSymbolicLink()) {
    return fs.readlinkSync(a) === fs.readlinkSync(b);
  }
  // A live file symlink compares by what it points to; the copy holds that content.
  const left = fs.statSync(a, { throwIfNoEntry: false });
  const right = fs.statSync(b, { throwIfNoEntry: false });
  if (!left || !right) {
    return false;
  }
  if (left.size !== right.size) {
    return false;
  }
  const chunk = 1 << 20;
  const ba = Buffer.alloc(chunk);
  const bb = Buffer.alloc(chunk);
  const fa = fs.openSync(a, "r");
  const fb = fs.openSync(b, "r");
  try {
    for (let offset = 0; offset < left.size; offset += chunk) {
      const na = fs.readSync(fa, ba, 0, chunk, offset);
      const nb = fs.readSync(fb, bb, 0, chunk, offset);
      if (na !== nb || !ba.subarray(0, na).equals(bb.subarray(0, nb))) {
        return false;
      }
    }
    return true;
  } finally {
    fs.closeSync(fa);
    fs.closeSync(fb);
  }
}

function listFiles(root: string, skip: (absolute: string) => boolean, out = new Set<string>()) {
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

/** What the upgraded shadow changed relative to the live tree. */
export function diffTree(
  live: string,
  shadow: string,
  skip: (absolute: string) => boolean,
): UpgradeOp[] {
  const liveFiles = listFiles(live, skip);
  const ops: UpgradeOp[] = [];
  // Accepted edge case: a symlinked directory is upgraded only in the private copy;
  // the swap leaves it alone, so the live target and its volume are never written.
  const underLinkedDirectory = (target: string) => {
    for (let dir = target; dir !== live && dir.startsWith(live); dir = path.dirname(dir)) {
      if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
        return fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory() === true;
      }
    }
    return false;
  };
  for (const next of listFiles(shadow, () => false)) {
    const target = path.join(live, path.relative(shadow, next));
    if (underLinkedDirectory(target)) {
      liveFiles.delete(target);
      continue;
    }
    if (!liveFiles.has(target)) {
      ops.push({ kind: "add", live: target, next });
    } else if (!sameContent(target, next)) {
      ops.push({ kind: "replace", live: target, next });
    }
    liveFiles.delete(target);
  }
  for (const target of liveFiles) {
    if (!underLinkedDirectory(target)) {
      ops.push({ kind: "remove", live: target });
    }
  }
  return ops;
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
      preserve(op.live, preservedPath(op.live, plan.appVersion));
    }
    if (op.kind === "remove") {
      fs.rmSync(op.live, { force: true });
    } else if (op.next && (fs.existsSync(op.next) || isSymlinkAt(op.next))) {
      fs.mkdirSync(path.dirname(op.live), { recursive: true });
      fs.renameSync(op.next, op.live);
    }
  }
  for (const directory of directories) {
    fsyncPath(directory, true);
  }
}

/**
 * Keep one prior generation. Removes `.pre-*` copies from other versions and the
 * backups the retired in-place migration made. Pinned versions stay.
 */
export function pruneGenerations(
  root: string,
  keepVersion: string,
  pinnedVersions: ReadonlySet<string>,
  skip: (absolute: string) => boolean,
): string[] {
  const removed: string[] = [];
  const walk = (directory: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (skip(absolute)) {
        continue;
      }
      const generation = /\.pre-(\d[^/]*)$/u.exec(entry.name)?.[1];
      const retiredBackup = RETIRED_BACKUP_NAME.test(entry.name);
      if (
        retiredBackup ||
        (generation !== undefined && generation !== keepVersion && !pinnedVersions.has(generation))
      ) {
        fs.rmSync(absolute, { recursive: true, force: true });
        removed.push(absolute);
      } else if (entry.isDirectory()) {
        walk(absolute);
      }
    }
  };
  walk(root);
  return removed;
}

function textColumns(db: DatabaseSync): Array<{ table: string; column: string }> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'",
    )
    // SAFETY: the statement fixes the column names and types of each row.
    .all() as Array<{ name: string }>;
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  return tables.flatMap(({ name }) =>
    readSqliteRows<{ name: string; type: string; hidden: number }>(
      db,
      `PRAGMA table_xinfo(${quote(name)})`,
    )
      .filter((column) => column.hidden === 0 && !/INT|REAL|BLOB/iu.test(column.type))
      .map((column) => ({ table: quote(name), column: quote(column.name) })),
  );
}

/**
 * Decode BLOB values stored in TEXT columns (issue #110186) so shipped steps and
 * the copy see text. Runs on private copies only.
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

/** Replace a path prefix in every text value of a SQLite file. */
export function rewriteSqlitePrefix(db: DatabaseSync, from: string, to: string): void {
  for (const { table, column } of textColumns(db)) {
    try {
      db.prepare(
        `UPDATE ${table} SET ${column} = replace(${column}, ?, ?) WHERE typeof(${column}) = 'text' AND instr(${column}, ?) > 0`,
      ).run(from, to, from);
    } catch {
      // FTS shadow tables cannot be updated directly; validation reports leftovers.
    }
  }
}

/** Count text values that still contain `needle`. */
export function countSqlitePrefix(db: DatabaseSync, needle: string): number {
  let found = 0;
  for (const { table, column } of textColumns(db)) {
    found += Number(
      (
        db
          .prepare(
            `SELECT count(*) AS n FROM ${table} WHERE typeof(${column}) = 'text' AND instr(${column}, ?) > 0`,
          )
          // SAFETY: the statement fixes the column names and types of each row.
          .get(needle) as { n: number }
      ).n,
    );
  }
  return found;
}

/** Replace a path prefix in a non-SQLite file or a symlink target. */
export function rewriteFilePrefix(file: string, from: string, to: string): boolean {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(file);
    if (!target.includes(from)) {
      return false;
    }
    fs.rmSync(file);
    fs.symlinkSync(target.replaceAll(from, to), file);
    return true;
  }
  const bytes = fs.readFileSync(file);
  if (bytes.indexOf(from) < 0) {
    return false;
  }
  const parts: Buffer[] = [];
  let start = 0;
  for (let at = bytes.indexOf(from); at >= 0; at = bytes.indexOf(from, start)) {
    parts.push(bytes.subarray(start, at), Buffer.from(to));
    start = at + Buffer.byteLength(from);
  }
  parts.push(bytes.subarray(start));
  fs.writeFileSync(file, Buffer.concat(parts), { mode: stat.mode & 0o7777 });
  return true;
}

export function listTreeFiles(root: string): string[] {
  return [...listFiles(root, () => false)];
}
