import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { LocalWorkspaceProjection } from "./local-workspace-store.js";

export async function readLocalWorkspaceProjection(id: string, env?: NodeJS.ProcessEnv) {
  const reply = await executeExistingOpenClawStateRead(
    { env },
    { type: "localWorkspace.get", input: { id } },
    { current: true, live: true },
  );
  if (!reply) {
    return undefined;
  }
  if (!reply.ok || reply.type !== "localWorkspace.get") {
    throw new Error("Unexpected local workspace result");
  }
  return reply.row;
}

export function observeLocalWorkspaceStoreSql() {
  const sql = observeHostDataSql();
  return {
    ...sql,
    calibrate() {
      const database = new DatabaseSync(":memory:");
      const query = "SELECT 1 AS local_workspace_sql_calibration";
      try {
        const statement = database.prepare(query);
        sql.queries.length = 0;
        statement.get();
        expect(sql.queries).toEqual([query]);
      } finally {
        database.close();
        sql.queries.length = 0;
        for (const call of sql.calls) {
          call.mockClear();
        }
      }
    },
    expectIdle() {
      const selectsProjection = (value: unknown) =>
        typeof value === "string" && value.includes("local_workspace_projections");
      expect(sql.queries.filter(selectsProjection)).toEqual([]);
      // Schema probes can bind the table name instead of including it in SQL.
      expect(
        sql.calls.flatMap((call) => call.mock.calls).filter((args) => args.some(selectsProjection)),
      ).toEqual([]);
    },
  };
}

export function localWorkspaceProjectionFixture(
  id: string,
  root: string,
): Omit<LocalWorkspaceProjection, "revision"> {
  return {
    worktree_id: id,
    agent_id: "main",
    session_key: `agent:main:workspace:${id}`,
    session_id: `session-${id}`,
    lifecycle_revision: null,
    projection_path: path.join(root, id, "workspace"),
    base_commit: "a".repeat(40),
    source_paths_json: "[]",
    baseline_json: null,
    baseline_ref: null,
    pending_ref: null,
    pending_target: null,
    journal_json: null,
    journal_pack: null,
    paused_runtimes_json: null,
    created_at_ms: 1,
  };
}
