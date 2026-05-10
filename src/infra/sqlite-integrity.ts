import type { DatabaseSync } from "node:sqlite";

type IntegrityCheckRow = {
  integrity_check?: unknown;
};

export function readSqliteIntegrityCheck(db: DatabaseSync): string {
  const row = db.prepare("PRAGMA integrity_check").get() as IntegrityCheckRow | undefined;
  const value = row?.integrity_check;
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function assertSqliteIntegrityOk(db: DatabaseSync, message: string): void {
  if (readSqliteIntegrityCheck(db) !== "ok") {
    throw new Error(message);
  }
}
