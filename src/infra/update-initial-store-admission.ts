import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "./update-managed-service-handoff-database.js";

export type UpdateInitialStoreSelection = Readonly<{
  privateRoot: Readonly<{ path: string; identity: string }>;
  installation: Readonly<{ path: string; identity: string }>;
  handoff: ManagedUpdateLeaseDatabaseIdentity;
  state: ManagedUpdateLeaseDatabaseIdentity;
}>;

type Store = "handoff" | "state";

function refuse(detail: string): never {
  throw new Error(`Update initial store admission refused: ${detail}`);
}

function canonical(filename: string): void {
  if (
    !path.isAbsolute(filename) ||
    path.normalize(filename) !== filename ||
    fs.realpathSync(filename) !== filename
  ) {
    refuse("aliased or noncanonical path");
  }
}

function privateDirectory(directory: string, identity: string, privateMode = true): void {
  canonical(directory);
  const stat = fs.lstatSync(directory, { bigint: true });
  if (
    !stat.isDirectory() ||
    `${stat.dev}:${stat.ino}` !== identity ||
    (process.getuid && stat.uid !== BigInt(process.getuid())) ||
    (privateMode && process.platform !== "win32" && (stat.mode & 0o077n) !== 0n)
  ) {
    refuse("private directory identity or ownership changed");
  }
}

function beneath(root: string, filename: string): void {
  const relative = path.relative(root, filename);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    refuse("selector is outside the private root");
  }
}

function assertDatabase(root: string, binding: ManagedUpdateLeaseDatabaseIdentity): void {
  beneath(root, binding.databasePath);
  canonical(binding.databasePath);
  privateDirectory(path.dirname(binding.databasePath), binding.parentIdentity);
  const stat = fs.lstatSync(binding.databasePath, { bigint: true });
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    (process.getuid && stat.uid !== BigInt(process.getuid())) ||
    (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n)
  ) {
    refuse("database is not a private single-linked regular file");
  }
  // Use the existing SQLite worker identity owner; no SQLite open or repair here.
  const actual = readDatabasePathIdentitySync(binding.databasePath);
  if (
    actual.canonicalPath !== binding.databasePath ||
    actual.key !== `file:${binding.databaseIdentity}` ||
    actual.key !== `file:${stat.dev}:${stat.ino}`
  ) {
    refuse("database generation changed");
  }
}

/**
 * Initial existing-store selection only, NOT an executor grant or a publication
 * authority. The CLI must call this before any database admission and retain the
 * existing native run/grant and state publication owners. A successor generation
 * needs a fresh selection from that publication owner, never an automatic refresh
 * of an old selection. This module neither opens nor provisions databases.
 */
export function admitUpdateInitialStores(input: UpdateInitialStoreSelection) {
  // Copy all nested input: a caller changing its request cannot retarget a guard.
  const selection: UpdateInitialStoreSelection = Object.freeze({
    privateRoot: Object.freeze({ ...input.privateRoot }),
    installation: Object.freeze({ ...input.installation }),
    handoff: Object.freeze({ ...input.handoff }),
    state: Object.freeze({ ...input.state }),
  });
  let closed = false;
  function assertCurrent(selectors?: {
    installationRoot: string;
    handoffPath: string;
    statePath: string;
  }): void {
    if (closed) {
      refuse("initial admission has settled");
    }
    const root = selection.privateRoot.path;
    privateDirectory(root, selection.privateRoot.identity);
    beneath(root, selection.installation.path);
    privateDirectory(selection.installation.path, selection.installation.identity, false);
    if (
      selectors &&
      (selectors.installationRoot !== selection.installation.path ||
        selectors.handoffPath !== selection.handoff.databasePath ||
        selectors.statePath !== selection.state.databasePath)
    ) {
      refuse("effective installation or store selectors diverged");
    }
    assertDatabase(root, selection.handoff);
    assertDatabase(root, selection.state);
    if (selection.handoff.databaseIdentity === selection.state.databaseIdentity) {
      refuse("handoff and state are the same physical database");
    }
    // Close over both roots again after inspecting the pair; no await/effects.
    privateDirectory(root, selection.privateRoot.identity);
    privateDirectory(selection.installation.path, selection.installation.identity, false);
  }
  assertCurrent();
  return Object.freeze({
    selection,
    assertCurrent,
    /** Call inside the existing DB owner's exclusion/lease, before its first query.
     * This witnesses this actual connection's main path plus the native pathname
     * identity. It does not replace that owner's native handle/ABA protections.
     * Each consumer must call it itself; a parent receipt cannot stand in for it.
     */
    observeConnection(store: Store, database: DatabaseSync) {
      assertCurrent();
      const rows = database.prepare("PRAGMA database_list").all(); // sqlite-allow-raw -- Observe the actual admitted connection, never infer it from environment.
      const main = rows.find((row) => row.name === "main");
      const binding = selection[store];
      if (
        main?.file !== binding.databasePath ||
        rows.some((row) => row.name !== "main" && row.name !== "temp")
      ) {
        refuse("connection uses a divergent or attached database");
      }
      const identity = readDatabasePathIdentitySync(binding.databasePath);
      assertCurrent();
      return Object.freeze({
        store,
        databasePath: binding.databasePath,
        databaseIdentity: identity.key,
        parentIdentity: binding.parentIdentity,
      });
    },
    /** Retire before an authorized publication changes the state's generation.
     * Reusing this guard after cutover is a defect, not a reason to deny cutover.
     */
    close() {
      closed = true;
    },
  });
}
