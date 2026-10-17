import path from "node:path";
import { vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { closeOpenClawAgentDatabasesForTest } from "./openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

export function closeDatabases() {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

export function openRawDatabase(pathname: string, options?: { readOnly?: boolean }) {
  return new (requireNodeSqlite().DatabaseSync)(pathname, options);
}

export function execSql(pathname: string, sql: string) {
  using database = openRawDatabase(pathname);
  database.exec(sql);
}

export function rejectSnapshot(pathname: string, message: string, normalize = false) {
  const prepare = snapshots.prepareSqliteReadOnlyLocation;
  return vi
    .spyOn(snapshots, "prepareSqliteReadOnlyLocation")
    .mockImplementation((source, options) => {
      if ((normalize ? path.resolve(source) : source) === pathname) {
        throw new Error(message);
      }
      return prepare(source, options);
    });
}

export function trackSettlement(run: Promise<unknown>) {
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  void run.then(markSettled, markSettled);
  return () => settled;
}
