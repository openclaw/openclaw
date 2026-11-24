// File steps for the copy-and-swap state upgrade: private copy, diff, journaled
// swap and retention. Nothing here writes a live file before the plan is durable.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { copyFileDescriptorSync } from "@openclaw/fs-safe/advanced";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { copyFileHandle } from "../infra/file-descriptor.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { retireSqliteDatabaseAdmissionForPath } from "../infra/sqlite-database-admission.js";
import {
  isSqlitePathOnBtrfs,
  setSqliteDirectoryNoCow,
  prepareSqliteDatabaseDirectory,
} from "../infra/sqlite-wal-filesystem.js";
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

/** Changes on any write, replacement or mode change of the file. */
function fileStamp(pathname: string): string | undefined {
  const stat = fs.lstatSync(pathname, { bigint: true, throwIfNoEntry: false });
  return stat && `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

// Small ancillary stores remain migration inputs; large current stores and operator
// images are not worth copying for a chain that does not own their schema.
const ANCILLARY_SQLITE_MAX_BYTES = 64 * 1024 * 1024;
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

export type UpgradeCopyScope = {
  directories: Set<string>;
  retiredBackups: { count: number; bytes: number };
};

/** Byte copies avoid copy_file_range sharing NOCOW database extents on btrfs. */
export async function copySqliteFamily(
  source: string,
  target: string,
  log?: { info: (message: string) => void },
): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (isSqlitePathOnBtrfs(source)) {
    // NOCOW is a performance policy; a host without chattr must still upgrade.
    try {
      setSqliteDirectoryNoCow(path.dirname(target));
    } catch (error) {
      createSubsystemLogger("state/upgrade").warn(
        `Could not enable NOCOW for ${path.dirname(target)}; copying with filesystem defaults: ${String(error)}`,
      );
    }
  }
  const files = ["", "-wal", "-journal"].flatMap((suffix) => {
    const stat = fs.statSync(`${source}${suffix}`, { throwIfNoEntry: false });
    return stat?.isFile() ? [{ suffix, size: stat.size, mode: stat.mode }] : [];
  });
  const completed = log
    ? reportCopy(
        files.reduce((sum, file) => sum + file.size, 0),
        files.length,
        log,
      )
    : undefined;
  for (const { suffix, mode } of files) {
    const input = await fs.promises.open(`${source}${suffix}`, "r");
    try {
      const output = await fs.promises.open(`${target}${suffix}`, "w", mode & 0o7777);
      try {
        await copyFileHandle(input, output);
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
  }
  // The caller holds exclusive custody. Recover the copied WAL/journal locally;
  // VACUUM is reserved for the generic rebuild's independent source snapshot.
  completed?.();
  if (files.some(({ suffix, size }) => suffix !== "" && size > 0)) {
    const db = openNodeSqliteDatabase(target);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;");
    } finally {
      db.close();
    }
  }
}

/** Inventory once, refuse insufficient space, then copy only migration inputs. */
export async function copyTree(
  live: string,
  shadow: string,
  skip: (absolute: string) => boolean,
  baseline: Map<string, string | undefined>,
  options: {
    requiredSqlite?: ReadonlySet<string>;
    log?: { info: (message: string) => void };
    additionalCopyBytes?: number;
  } = {},
): Promise<UpgradeCopyScope> {
  const scope: UpgradeCopyScope = {
    directories: new Set(),
    retiredBackups: { count: 0, bytes: 0 },
  };
  const files: Array<{
    source: string;
    target: string;
    mode: number;
    sqlite: boolean;
    link?: string;
  }> = [];
  const rootStat = fs.statSync(live);
  const btrfs = isSqlitePathOnBtrfs(live);
  const mounts = new Set<string>();
  if (process.platform === "linux") {
    for (const line of fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      const mount = line.split(" ")[4];
      if (mount) {
        mounts.add(decodeMountInfoPath(mount));
      }
    }
  }
  let bytes = options.additionalCopyBytes ?? 0;
  const walk = (directory: string, visited: ReadonlySet<string>, retired = false) => {
    if (!retired) {
      scope.directories.add(directory);
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (skip(source)) {
        continue;
      }
      const stat = fs.statSync(source, { throwIfNoEntry: false });
      const real = stat ? fs.realpathSync(source) : source;
      if (skip(real) || (stat && stat.dev !== rootStat.dev) || mounts.has(real)) {
        continue;
      }
      const backup = retired || RETIRED_BACKUP_NAME.test(entry.name);
      if (stat?.isDirectory()) {
        // Btrfs subvolume roots have inode 256, including same-device subvolumes.
        if (visited.has(real) || (btrfs && stat.ino === 256) || GENERATION_NAME.test(entry.name)) {
          continue;
        }
        if (!backup && entry.isSymbolicLink() && source.split(path.sep).includes("node_modules")) {
          files.push({
            source,
            target: path.join(shadow, path.relative(live, source)),
            mode: stat.mode,
            sqlite: false,
            link: fs.readlinkSync(source),
          });
        } else {
          walk(source, new Set([...visited, real]), backup);
        }
        continue;
      }
      if (backup) {
        scope.retiredBackups.count++;
        scope.retiredBackups.bytes += stat?.size ?? 0;
        continue;
      }
      if (skipEntry(entry.name) || (stat && !stat.isFile())) {
        continue;
      }
      const target = path.join(shadow, path.relative(live, source));
      if (!stat) {
        if (entry.isSymbolicLink()) {
          files.push({ source, target, mode: 0, sqlite: false, link: fs.readlinkSync(source) });
        }
        continue;
      }
      const sqlite = isSqliteFile(source);
      const fileBytes =
        stat.size +
        (sqlite
          ? ["-wal", "-journal"].reduce(
              (sum, suffix) =>
                sum + (fs.statSync(`${source}${suffix}`, { throwIfNoEntry: false })?.size ?? 0),
              0,
            )
          : 0);
      if (
        sqlite &&
        fileBytes > ANCILLARY_SQLITE_MAX_BYTES &&
        !options.requiredSqlite?.has(source)
      ) {
        continue;
      }
      files.push({ source, target, mode: stat.mode, sqlite });
      // Budget ordinary files too: FICLONE may fall back to a full byte copy.
      bytes += fileBytes;
    }
  };
  walk(live, new Set([fs.realpathSync(live)]));
  for (const required of options.requiredSqlite ?? []) {
    if (fs.existsSync(required) && !files.some((file) => file.source === required)) {
      throw new Error(
        `State upgrade refused: database ${required} is outside the copy scope. Nothing live was changed. Run openclaw doctor --fix under offline maintenance, then start the Gateway again.`,
      );
    }
  }
  checkCopySpace(live, bytes);
  const completed = reportCopy(bytes, files.length, options.log);
  for (const directory of scope.directories) {
    fs.mkdirSync(path.join(shadow, path.relative(live, directory)), {
      recursive: true,
      mode: 0o700,
    });
  }
  for (const file of files) {
    if (file.link !== undefined) {
      fs.symlinkSync(file.link, file.target);
    } else {
      if (file.sqlite) {
        await copySqliteFamily(file.source, file.target);
      } else {
        fs.copyFileSync(file.source, file.target, fs.constants.COPYFILE_FICLONE);
      }
      fs.chmodSync(file.target, file.mode & 0o7777);
    }
    baseline.set(file.target, fileStamp(file.target));
  }
  completed();
  return scope;
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

/** Shadow files the upgrade wrote or created since `copyTree`. */
export function changedShadowFiles(
  shadow: string,
  baseline: ReadonlyMap<string, string | undefined>,
): string[] {
  return [...listFiles(shadow, () => false)].filter(
    (file) => baseline.get(file) !== fileStamp(file),
  );
}

/**
 * What the upgrade changed in the shadow since `copyTree`. Live files the copy did
 * not include, or that changed only on the live side, are left alone.
 */
export function diffTree(
  live: string,
  shadow: string,
  baseline: ReadonlyMap<string, string | undefined>,
  warn: (message: string) => void = () => {},
): UpgradeOp[] {
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
  for (const next of changedShadowFiles(shadow, baseline)) {
    const target = path.join(live, path.relative(shadow, next));
    if (underLinkedDirectory(target)) {
      continue;
    }
    if (!fs.existsSync(target) && !isSymlinkAt(target)) {
      ops.push({ kind: "add", live: target, next });
    } else if (!baseline.has(next)) {
      warn(`Left uncopied live file unchanged: ${path.relative(live, target)}`);
    } else if (!sameContent(target, next)) {
      ops.push({ kind: "replace", live: target, next });
    }
  }
  for (const copied of baseline.keys()) {
    const target = path.join(live, path.relative(shadow, copied));
    if (
      !fs.lstatSync(copied, { throwIfNoEntry: false }) &&
      (fs.existsSync(target) || isSymlinkAt(target)) &&
      !underLinkedDirectory(target)
    ) {
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
    if (op.next && isSqliteFile(op.next)) {
      // Native close retains admission's identity descriptor. Windows cannot
      // replace either file until the joined swap owner releases that custody.
      retireSqliteDatabaseAdmissionForPath(op.live);
      retireSqliteDatabaseAdmissionForPath(op.next);
    }
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
          .get(needle) as { n: number | bigint }
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
  if (!bytes.includes(from)) {
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
