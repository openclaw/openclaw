import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import type { PostgresSyncConnection } from "./postgres-sync/connection.js";
import { resolveSqliteInspectionSignal } from "./sqlite-readonly-worker-context.js";
import { resolveUpdateSqlitePath } from "./update-database-path.js";

// Generic database paths only need to know whether an update capture is active. The capture
// owner registers its migration attribution when it starts, so workers that open databases
// never load update inspection code.
export type UpdateDoctorMigrationCapture = {
  /** Captured SQLite sources admitted by this Doctor session. */
  openedSqlitePaths?: Set<string>;
  expected(pathname: string): string | null | undefined;
  /** The generation an index rebuilt over the expected WAL frames binds without a commit. */
  rebuiltIndex(pathname: string): string | undefined;
  assertCurrent(): void;
  accept(pathname: string, before: string | null, after: string | null): void;
  refuse(message: string): void;
};

export type MigrationSource = {
  path: string;
  generation: string;
  assertCurrent(this: void): void;
};
export type DoctorMigrationBackup = (
  db: DatabaseSync,
  options: { path: string; env: NodeJS.ProcessEnv; tables: readonly string[] },
) => { capture: MigrationSource; backupPath: string };
export type DoctorMigrationFullBackup = { path: string; generation?: string };
export const updateDoctorMigrationContext = new AsyncLocalStorage<{
  capture?: UpdateDoctorMigrationCapture;
  source?: MigrationSource;
  companions?: readonly MigrationSource[];
  assertMigrationCurrent?: () => void;
  backup?: DoctorMigrationBackup;
  fullBackups?: Map<string, DoctorMigrationFullBackup>;
}>();

export function hasUpdateDoctorMigrationCapture(): boolean {
  return updateDoctorMigrationContext.getStore()?.capture !== undefined;
}

/** A source proof exists only within its verified migration's lexical interval. */
export function getUpdateDoctorMigrationSource(pathname: string) {
  const context = updateDoctorMigrationContext.getStore();
  const key = resolveUpdateSqlitePath(pathname);
  const source =
    context?.source?.path === key
      ? context.source
      : context?.companions?.find((entry) => entry.path === key);
  if (!source) {
    return undefined;
  }
  const { generation, assertCurrent } = source;
  assertCurrent();
  return { path: pathname, generation, assertCurrent };
}

export function getDoctorMigrationBackup(
  db: DatabaseSync,
  options: Parameters<DoctorMigrationBackup>[1],
) {
  const context = updateDoctorMigrationContext.getStore();
  if (context?.capture) {
    if (context.capture.expected(resolveUpdateSqlitePath(options.path)) !== undefined) {
      throw new Error("Updater migration requires its captured source generation.");
    }
    context.capture.refuse("The migration source path is outside the updater's captured paths.");
    // Relocation cannot certify the installed driver's old path keys. A fresh Doctor
    // backup may still preserve this source without becoming that updater's baseline.
    return updateDoctorMigrationContext.run(
      { ...context, capture: undefined, source: undefined },
      () => context.backup?.(db, options),
    );
  }
  return context?.backup?.(db, options);
}

export type UpdateSqliteMigrationOptions = {
  /** Prepare the admitted connection after verifying its preimage, before native exclusion. */
  beforeExclusive?: () => void;
  /** Close a one-shot native owner before publishing its final generation. */
  close?: () => void;
  retainExclusive?: boolean;
  created?: boolean;
  /** Already-open companion custody stays held through this synchronous native phase. */
  companions?: readonly { database: DatabaseSync; path: string; created?: boolean }[];
};

type SqliteMigrationArgs<T> = [
  db: DatabaseSync,
  pathname: string,
  operation: () => T,
  options?: UpdateSqliteMigrationOptions,
];

type PostgresMigrationAttribution = {
  run<T>(operation: () => T): T;
  beforeCommit(): void;
  committed(): void;
};

type UpdateMigrationAttribution = {
  beginPostgres(
    db: PostgresSyncConnection,
    assertMigrationCurrent?: () => void,
  ): PostgresMigrationAttribution | undefined;
  beginSqliteCompanion(
    db: DatabaseSync,
    pathname: string,
    created: boolean,
  ): { complete(): void } | undefined;
  runSqlite<T>(...args: SqliteMigrationArgs<T>): T;
  runSqliteAsync<T>(...args: SqliteMigrationArgs<T>): Promise<T>;
};

let attribution: UpdateMigrationAttribution | undefined;

/** Only the update capture owner registers; a capture cannot exist before it does. */
export function registerUpdateMigrationAttribution(owner: UpdateMigrationAttribution): void {
  attribution = owner;
}

function capturedAttribution(): UpdateMigrationAttribution | undefined {
  if (!hasUpdateDoctorMigrationCapture()) {
    return undefined;
  }
  if (!attribution) {
    throw new Error("Update migration capture is active without its attribution owner.");
  }
  return attribution;
}

/** Retain the source's native exclusion across its commits and isolated postimage read. */
export function runUpdateSqliteMigration<T>(...args: SqliteMigrationArgs<T>): T {
  const owner = capturedAttribution();
  return owner ? owner.runSqlite(...args) : args[2]();
}

/** Await observations outside transactions while the native migration owner stays held. */
export async function runUpdateSqliteMigrationAsync<T>(
  ...args: SqliteMigrationArgs<T>
): Promise<T> {
  const owner = capturedAttribution();
  if (owner) {
    return await owner.runSqliteAsync(...args);
  }
  resolveSqliteInspectionSignal(getAsyncWorkSignal())?.throwIfAborted();
  const value = args[2]();
  if (isPromiseLike(value)) {
    throw new Error("Update migration callbacks must remain synchronous.");
  }
  return value;
}

/** Called inside the engine's migration transaction, before its first mutation. */
export function beginUpdatePostgresMigration(
  db: PostgresSyncConnection,
  assertMigrationCurrent?: () => void,
): PostgresMigrationAttribution | undefined {
  return capturedAttribution()?.beginPostgres(db, assertMigrationCurrent);
}

/** Companion custody attaches to the source migration that the capture already verified. */
export function beginUpdateSqliteCompanion(db: DatabaseSync, pathname: string, created: boolean) {
  return capturedAttribution()?.beginSqliteCompanion(db, pathname, created);
}
