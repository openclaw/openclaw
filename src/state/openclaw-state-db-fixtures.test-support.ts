import fs from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { expect, type MockInstance } from "vitest";
import type { EngineConnection } from "../infra/sql-connection.js";

export function readRow(db: EngineConnection, sql: string, ...values: SQLInputValue[]) {
  return db.prepare(sql).get(...values);
}

export function readRows(db: EngineConnection, sql: string, ...values: SQLInputValue[]) {
  return db.prepare(sql).all(...values);
}

export function expectRow(
  db: EngineConnection,
  sql: string,
  expected: unknown,
  ...values: SQLInputValue[]
) {
  expect(readRow(db, sql, ...values), sql).toEqual(expected);
}

export function expectRows(
  db: EngineConnection,
  sql: string,
  expected: unknown,
  ...values: SQLInputValue[]
) {
  expect(readRows(db, sql, ...values), sql).toEqual(expected);
}

export function expectCalls(count: number, ...mocks: MockInstance[]) {
  for (const mock of mocks) {
    expect(mock).toHaveBeenCalledTimes(count);
  }
}

export function makeReadSource(directories: { make(prefix: string): string }, prefix: string) {
  const root = directories.make(prefix);
  const pathname = path.join(root, "source.sqlite");
  // Transport fixtures need a filesystem identity, not a valid SQLite database.
  fs.writeFileSync(pathname, "synthetic read source");
  return { path: pathname, env: { OPENCLAW_STATE_DIR: root } };
}

export function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}
