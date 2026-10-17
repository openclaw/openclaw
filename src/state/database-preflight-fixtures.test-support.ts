import fs from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { closeOpenClawAgentDatabasesForTest } from "./openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

export const supportedVersions = {
  state: OPENCLAW_STATE_SCHEMA_VERSION,
  agent: OPENCLAW_AGENT_SCHEMA_VERSION,
};
export const compatible = { incompatible: [], indeterminate: [] };

export function versionRow(
  kind: "state" | "agent",
  pathname: string,
  foundVersion: number,
  supportedVersion?: number,
) {
  return {
    kind,
    path: pathname,
    foundVersion,
    ...(supportedVersion === undefined ? {} : { supportedVersion }),
  };
}

export function failureRow(kind: "state" | "agent", pathname: string, reason: unknown) {
  return { kind, path: pathname, reason };
}

export function agentConfig(ids: string[], systemAgent: string): OpenClawConfig {
  return {
    agents: {
      entries: Object.fromEntries(ids.map((id) => [id, {}])),
      defaults: { systemAgent: { agentId: systemAgent } },
    },
  };
}

export function expectFiles(paths: string[], exists: boolean) {
  expect(paths.map((pathname) => fs.existsSync(pathname))).toEqual(paths.map(() => exists));
}

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
