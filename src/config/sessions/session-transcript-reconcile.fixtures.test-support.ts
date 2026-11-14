import type { SQLInputValue } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import type { SqlConnection } from "../../infra/sql-connection.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";

export function useReconcileTestRuntime() {
  const observer = useReconcileWorkerObserver();
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  return { observer, tempDirs };
}

export const rows = (db: SqlConnection, sql: string, ...bindings: SQLInputValue[]) =>
  db.prepare(sql).all(...bindings);

export const row = (db: SqlConnection, sql: string, ...bindings: SQLInputValue[]) =>
  db.prepare(sql).get(...bindings);

export function expectRows(
  db: SqlConnection,
  sql: string,
  expected: unknown,
  ...bindings: SQLInputValue[]
) {
  expect(rows(db, sql, ...bindings)).toEqual(expected);
}

export const rebuildState = (db: SqlConnection, sessionId?: string) =>
  row(
    db,
    `SELECT needs_rebuild FROM session_transcript_index_state${sessionId ? " WHERE session_id = ?" : ""}`,
    ...(sessionId ? [sessionId] : []),
  );

export const expectReconciled = (result: Promise<unknown>, reconciledSessions = 1) =>
  expect(result).resolves.toEqual({ reconciledSessions });

export const projectionMessages = (db: SqlConnection) =>
  rows(db, "SELECT message_id, text FROM session_transcript_fts");

export function projectionSnapshot(db: SqlConnection, sessionId: string) {
  const query = (sql: string) => rows(db, sql, sessionId);
  return {
    index: row(db, "SELECT * FROM session_transcript_index_state WHERE session_id = ?", sessionId),
    active: query(
      "SELECT * FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
    ),
    // Keep orphan FTS rows visible as well as their mapping IDs.
    fts: query(`SELECT CAST(m.id AS TEXT) AS id, f.* FROM session_transcript_fts f
      LEFT JOIN session_transcript_fts_rows m ON m.id = f.rowid
      WHERE f.session_id = ? ORDER BY f.message_id`),
  };
}

export function markRebuild(db: SqlConnection, sessionId?: string) {
  db.prepare(
    `UPDATE session_transcript_index_state SET needs_rebuild = 1${sessionId ? " WHERE session_id = ?" : ""}`,
  ).run(...(sessionId ? [sessionId] : []));
}

export function seedScanBacklog(db: SqlConnection, sessionKey: string) {
  db.prepare(`WITH RECURSIVE candidates(n) AS (
      VALUES (0) UNION ALL SELECT n + 1 FROM candidates WHERE n < 199
    ) INSERT INTO session_windows (session_id, session_key, created_at, updated_at)
      SELECT printf('a-%03d', n), ?, 1, 1 FROM candidates`).run(sessionKey);
}

export function reconcileScope(stateDir: string, sessionId: string) {
  const options = { agentId: "main", env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  return { options, scope: { ...options, sessionId, sessionKey: `agent:main:${sessionId}` } };
}

export async function seedTranscript(
  scope: Parameters<typeof persistSessionTranscriptTurn>[0],
  eventId: string,
  content: string,
  parentId?: null,
) {
  await persistSessionTranscriptTurn(scope, {
    messages: [
      { eventId, ...(parentId === null ? { parentId } : {}), message: { role: "user", content } },
    ],
    touchSessionEntry: false,
  });
}

export async function closeReconcileDatabases(stateDir?: string) {
  await closeOpenClawAgentDatabasesAsync(stateDir);
  await closeOpenClawStateDatabaseAsync();
}

export function readAgentDatabaseLeaseIds(pathname: string, env?: NodeJS.ProcessEnv): string[] {
  return openOpenClawStateDatabase({ env })
    .db.prepare(
      "SELECT lease_id FROM agent_database_leases WHERE owner_pid = ? AND path = ? ORDER BY lease_id",
    )
    .all(process.pid, pathname)
    .map((lease) => String(lease.lease_id));
}

export function observeCanonicalWriterLeases() {
  const leases = new Map<string, string>();
  const spy = sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
    const facts = request.facts;
    if (
      request.stage === "open" &&
      isRecord(facts) &&
      typeof facts.databasePath === "string" &&
      typeof facts.leaseId === "string"
    ) {
      leases.set(facts.databasePath, facts.leaseId);
    }
    admit(request, grant);
  });
  const restore = () => spy.mockRestore();
  return { leases, restore, [Symbol.dispose]: restore };
}

export function acquireReconcileGatewayOwner(
  context: OpenClawStateWorkerContext,
  state: OpenClawTestState,
  owned: boolean,
) {
  return owned
    ? acquireGatewayStateOwner({
        databasePath: context.admission.databasePath,
        payload: {
          pid: process.pid,
          processNamespace: readGatewayLockProcessNamespace(),
          createdAt: new Date().toISOString(),
          configPath: state.configPath,
          stateDir: state.stateDir,
          role: "gateway",
        },
      })
    : undefined;
}

// Intercept only execution; preserve the real operation's admission and lifetime arguments.
export function interceptWorkerExecution(
  intercept: <Operations extends SqliteWorkerOperations>(
    execute: SqliteWorkerStore<Operations>["execute"],
  ) => SqliteWorkerStore<Operations>["execute"],
) {
  const run = workerStore.runSqliteWorkerStoreOperation;
  const wrapped: typeof run = (target, operation, ...context) =>
    run(
      target,
      (worker) => operation({ execute: intercept(worker.execute.bind(worker)) }),
      ...context,
    );
  return vi.spyOn(workerStore, "runSqliteWorkerStoreOperation").mockImplementation(wrapped);
}
