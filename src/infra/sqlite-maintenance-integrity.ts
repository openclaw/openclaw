import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getOrCreateWeakOwnerMap } from "../shared/weak-owner-map.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-maintenance-context.js";
import { sameFileMutationFingerprint, type FileMutationFingerprint } from "./file-descriptor.js";
import { hasUncommittedSqliteWrites } from "./sqlite-schema-facts.js";

export type SqliteIntegrityCheckOptions = {
  check?: "quick" | "full";
  /** Constraint-only migration admission; never a full database verification. */
  schemaOnly?: true;
  /** Tables rewritten or re-indexed by the migration; absent tables may be created by it. */
  tables?: readonly string[];
  /**
   * Owned FTS5 definitions whose inverted indexes are derived data. When these
   * are the only findings, the check passes: a SQLite tokenizer change makes a
   * healthy index report "malformed", and the runtime that next admits the
   * database rebuilds it.
   */
  ftsSchemas?: readonly string[];
};

type CapturedIntegrity = {
  schemaOnly: boolean;
  source: FileMutationFingerprint;
  tables: ReadonlySet<string>;
};

const capturedIntegrity = new WeakMap<
  OpenClawDatabaseMaintenanceScope,
  Map<string, CapturedIntegrity>
>();

/** Only a recovery-free raw copy has the source's exact pre-normalization bytes. */
export function captureSqliteMaintenanceIntegrity(
  pathname: string,
  options?: SqliteIntegrityCheckOptions,
): (() => void) | undefined {
  const scope = getOpenClawDatabaseMaintenanceScope();
  if (options?.check !== "quick" || !scope?.ownsSchemaMaintenance) {
    return undefined;
  }
  if (
    fs.existsSync(`${pathname}-journal`) ||
    (fs.statSync(`${pathname}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0
  ) {
    return undefined;
  }
  const source = fs.statSync(pathname, { bigint: true });
  const tables = new Set(options.tables);
  const key = path.resolve(pathname);
  // The raw-copy owner compares every byte before returning this image. Record
  // its successful QUICK before any private normalization or transform runs.
  return () => {
    const receipts = getOrCreateWeakOwnerMap(capturedIntegrity, scope);
    receipts.set(key, { source, tables, schemaOnly: options.schemaOnly === true });
  };
}

/** A copied QUICK is usable once, in the same custody, before any source mutation. */
export function consumeSqliteMaintenanceIntegrity(
  database: DatabaseSync,
  pathname: string,
  options: SqliteIntegrityCheckOptions,
): boolean {
  if (options.check !== "quick") {
    return false;
  }
  const scope = getOpenClawDatabaseMaintenanceScope();
  const receipts = scope && capturedIntegrity.get(scope);
  if (!receipts) {
    return false;
  }
  const key = path.resolve(pathname);
  const receipt = receipts?.get(key);
  if (!receipt) {
    return false;
  }
  receipts.delete(key);
  if (hasUncommittedSqliteWrites(database)) {
    return false;
  }
  const source = fs.statSync(pathname, { bigint: true, throwIfNoEntry: false });
  // A native read may create an empty WAL; it contains no changed database pages.
  const hasRecoveryData = ["-wal", "-journal"].some(
    (suffix) => (fs.statSync(`${pathname}${suffix}`, { throwIfNoEntry: false })?.size ?? 0) > 0,
  );
  return (
    receipt.schemaOnly === (options.schemaOnly === true) &&
    source !== undefined &&
    sameFileMutationFingerprint(receipt.source, source) &&
    !hasRecoveryData &&
    (options.tables ?? []).every((table) => receipt.tables.has(table))
  );
}
