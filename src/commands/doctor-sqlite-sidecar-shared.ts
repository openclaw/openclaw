import { existsSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const SQLITE_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

type TableInfoRow = {
  name: string;
};

export function normalizeSidecarNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

export function serializeSidecarJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Legacy JSON columns are typed by the receiving field.
export function parseSidecarJsonValue<T>(raw: string | null): T | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function hasLegacySidecarColumn(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];
  return rows.some((row) => row.name === columnName);
}

export function removeSqliteSidecars(pathname: string): boolean {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    rmSync(`${pathname}${suffix}`, { force: true });
  }
  return !existsSync(pathname);
}
