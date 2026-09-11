import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { hasErrnoCode } from "./errno.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";

export type BackupSqliteSource = {
  path: string;
  identity: Stats;
};

export type BackupSqliteSourceGroup = {
  sources: [BackupSqliteSource, ...BackupSqliteSource[]];
  sourcePath: string;
  walIdentity: Stats | null;
};

function hasKnownIdentity(identity: Stats): boolean {
  return process.platform !== "win32" || (identity.dev !== 0 && identity.ino !== 0);
}

async function readRegularSidecar(pathname: string): Promise<Stats | null> {
  let identity: Stats;
  try {
    identity = await fs.lstat(pathname);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  if (!identity.isFile()) {
    throw new Error(`SQLite hardlink sidecar must be a regular file: ${pathname}`);
  }
  return identity;
}

async function assertGroupPaths(group: BackupSqliteSourceGroup): Promise<void> {
  for (const source of group.sources) {
    const current = await fs.lstat(source.path);
    if (
      !current.isFile() ||
      !sameFileIdentity(source.identity, current) ||
      (group.sources.length > 1 && !hasKnownIdentity(current)) ||
      (await fs.realpath(source.path)) !== source.path
    ) {
      throw new Error(`SQLite backup source identity changed: ${source.path}`);
    }
    if (current.nlink !== group.sources.length) {
      throw new Error(
        `SQLite hardlink journal owner may be outside the backup inventory: ${source.path} has ${current.nlink} links, but ${group.sources.length} paths were admitted. Include every database hardlink before retrying.`,
      );
    }
  }
}

async function readGroupWalOwners(
  group: BackupSqliteSourceGroup,
): Promise<Array<{ path: string; identity: Stats }>> {
  const owners: Array<{ path: string; identity: Stats }> = [];
  for (const source of group.sources) {
    const wal = await readRegularSidecar(`${source.path}-wal`);
    const journal = await readRegularSidecar(`${source.path}-journal`);
    await readRegularSidecar(`${source.path}-shm`);
    if (journal && journal.size > 0) {
      throw new Error(
        `SQLite hardlink journal ownership cannot be established safely while a rollback journal is present: ${source.path}. Close the database cleanly before retrying.`,
      );
    }
    if (wal && wal.size > 0) {
      if (!hasKnownIdentity(wal)) {
        throw new Error(`SQLite hardlink WAL identity cannot be verified: ${source.path}-wal`);
      }
      owners.push({ path: source.path, identity: wal });
    }
  }
  if (owners.length > 1) {
    throw new Error(
      `Ambiguous SQLite hardlink journal ownership: multiple non-empty WAL files for ${group.sources.map((source) => source.path).join(", ")}. Close the database writers before retrying.`,
    );
  }
  return owners;
}

async function assertGroupBinding(group: BackupSqliteSourceGroup): Promise<void> {
  await assertGroupPaths(group);
  if (group.sources.length === 1) {
    return;
  }
  const [owner] = await readGroupWalOwners(group);
  if (
    group.walIdentity
      ? !owner ||
        owner.path !== group.sourcePath ||
        !sameFileIdentity(group.walIdentity, owner.identity)
      : owner !== undefined
  ) {
    throw new Error(`SQLite hardlink journal ownership changed during backup: ${group.sourcePath}`);
  }
}

/** Canonical database owners are resolved before generic pathname journal ownership. */
export async function planBackupSqliteSourceGroups(
  sources: readonly BackupSqliteSource[],
): Promise<Map<string, BackupSqliteSourceGroup>> {
  const groups = new Map<string, BackupSqliteSourceGroup>();
  for (const source of sources) {
    const knownIdentity = hasKnownIdentity(source.identity);
    if (!knownIdentity && source.identity.nlink > 1) {
      throw new Error(`SQLite hardlink identity cannot be verified: ${source.path}`);
    }
    const key = knownIdentity ? `${source.identity.dev}:${source.identity.ino}` : source.path;
    const group = groups.get(key);
    if (group) {
      group.sources.push(source);
    } else {
      groups.set(key, { sources: [source], sourcePath: source.path, walIdentity: null });
    }
  }
  const byPath = new Map<string, BackupSqliteSourceGroup>();
  for (const group of groups.values()) {
    await assertGroupPaths(group);
    if (group.sources.length > 1) {
      const [owner] = await readGroupWalOwners(group);
      if (owner) {
        group.sourcePath = owner.path;
        group.walIdentity = owner.identity;
      }
    }
    for (const source of group.sources) {
      byPath.set(source.path, group);
    }
  }
  return byPath;
}

export async function captureBackupSqliteSourceGroup(
  group: BackupSqliteSourceGroup,
  capture: () => Promise<unknown>,
): Promise<void> {
  await assertGroupBinding(group);
  // SQLite owns source descriptors: closing a raw fs descriptor can release
  // another connection's POSIX locks in this process. WAL appends remain valid.
  await capture();
  await assertGroupBinding(group);
}
