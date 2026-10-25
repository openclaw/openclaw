import fs from "node:fs";
import nodePath from "node:path";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import * as agentDb from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import {
  assertOpenClawDatabasesReady as assertReady,
  preflightOpenClawDatabaseSchemas as inspectSchemas,
} from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import * as stateDb from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

type ReadinessOptions = Parameters<typeof assertReady>[0];
type InspectionOptions = Parameters<typeof inspectSchemas>;

export function databaseFixture(dir: string, extraEnv?: NodeJS.ProcessEnv) {
  const env = { ...extraEnv, OPENCLAW_STATE_DIR: dir };
  return {
    dir,
    env,
    statePath: resolveOpenClawStateSqlitePath(env),
    agentPath: (agentId = "main") => resolveOpenClawAgentSqlitePath({ agentId, env }),
    state: () => stateDb.openOpenClawStateDatabase({ env }),
    agent: (agentId = "main", pathname?: string) =>
      agentDb.openOpenClawAgentDatabase({ agentId, path: pathname, env }),
    close: closeDatabases,
    doctor: (
      configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[] = [],
      config?: OpenClawConfig,
    ) =>
      assertReady({
        env,
        config,
        operation: "doctor",
        configuredAgentDatabaseTargets,
      }),
    ready: (
      config?: OpenClawConfig,
      operation: "gateway-startup" | "gateway-restart" = "gateway-startup",
      callbacks: Pick<ReadinessOptions, "onAgentInspection" | "onRegisteredAgentDatabases"> = {},
    ) =>
      operation === "gateway-startup"
        ? assertReady({ env, config: config ?? {}, operation, ...callbacks })
        : assertReady({ env, config, operation, ...callbacks }),
    inspect: (options: Omit<InspectionOptions[0], "env"> = {}, purpose?: InspectionOptions[1]) =>
      inspectSchemas({ env, ...options }, purpose),
  };
}

export const supportedVersions = {
  state: OPENCLAW_STATE_SCHEMA_VERSION,
  agent: OPENCLAW_AGENT_SCHEMA_VERSION,
};
export const compatible = { incompatible: [], indeterminate: [] };

export const versionRow = (
  kind: "state" | "agent",
  path: string,
  foundVersion: number,
  supportedVersion?: number,
) => ({
  kind,
  path,
  foundVersion,
  ...(supportedVersion === undefined ? {} : { supportedVersion }),
});

export function failureRow(kind: "state" | "agent", path: string, reason: unknown) {
  return { kind, path, reason };
}

export const agentConfig = (ids: string[], systemAgent: string): OpenClawConfig => ({
  agents: {
    entries: Object.fromEntries(ids.map((id) => [id, {}])),
    defaults: { systemAgent: { agentId: systemAgent } },
  },
});

export function expectFiles(paths: string[], exists: boolean) {
  expect(paths.map((pathname) => fs.existsSync(pathname))).toEqual(paths.map(() => exists));
}

export function closeDatabases() {
  agentDb.closeOpenClawAgentDatabasesForTest();
  stateDb.closeOpenClawStateDatabaseForTest();
}

export const openRawDatabase = (pathname: string, options: { readOnly?: boolean } = {}) =>
  new (requireNodeSqlite().DatabaseSync)(pathname, options);

export function execSql(pathname: string, sql: string) {
  using database = openRawDatabase(pathname);
  database.exec(sql);
}

export function rejectSnapshot(pathname: string, message: string, normalize = false) {
  const prepare = snapshots.prepareSqliteReadOnlyLocation;
  return vi
    .spyOn(snapshots, "prepareSqliteReadOnlyLocation")
    .mockImplementation((source, options) => {
      if ((normalize ? nodePath.resolve(source) : source) === pathname) {
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
