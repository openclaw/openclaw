import type { SQLInputValue } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getMessageRangeReaders } from "../../config/sessions/session-accessor.sqlite-projection-read.js";
import { readDiskEvictableArchivedSessionBatchInDatabase } from "../../config/sessions/session-history-eviction-candidates.js";
import { listTerminalOperatorApprovalsInDatabase } from "../../gateway/operator-approval-store.kernel.worker.js";
import { createExecApprovalPresentation } from "../../gateway/operator-approval-store.test-support.js";
import { NodeWorkerJournalWorker } from "../../node-host/node-worker-journal-worker.js";
import { NodeWorkerLaunchStore } from "../../node-host/node-worker-launch-store.js";
import { requireNodeWorkerProcessIdentity } from "../../node-host/node-worker-process-identity.js";
import { NodeWorkerTurnStore } from "../../node-host/node-worker-turn-store.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { buildApprovalResolutionRef } from "../approval-resolution-ref.js";
import { acquireStateDatabaseSchemaLease } from "../gateway-state-owner.js";
import { createPostgresPoolEndpoints, postgresPoolTransferList } from "../postgres-sync/pool.js";
import { isPostgresSqlConnection, type EngineConnection } from "../sql-connection.js";
import { captureSqliteDatabaseAdmissions } from "../sqlite-database-admission.js";
import { runSqliteImmediateTransactionSync } from "../sqlite-transaction.js";
import { createSqliteWorkerOperationAdmission } from "../sqlite-worker-operation-admission.js";
import { captureSqliteWorkerStateContext } from "../sqlite-worker-state-context.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { conformanceWorkerResult } from "./conformance.test-support.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const now = 10 * 24 * 60 * 60_000;
const key = (n: number) => `agent:main:partial-${n}`;
const claim = {
  launchId: "partial-current",
  planHash: "a".repeat(64),
  gatewayNamespace: "partial-gateway",
  environmentId: "partial-environment",
  sessionId: "partial-session",
  ownerEpoch: 1,
  placementGeneration: 1,
  runId: "partial-run",
};

// Bulk fixture writes retain canonical constraints and every sibling index.
function insertRows(
  db: EngineConnection,
  table: string,
  columns: readonly string[],
  rows: Iterable<readonly SQLInputValue[]>,
) {
  let batch: Array<readonly SQLInputValue[]> = [];
  const flush = () => {
    if (!batch.length) {
      return;
    }
    db.prepare(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES ${batch.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ")}`,
    ).run(...batch.flat());
    batch = [];
  };
  for (const row of rows) {
    batch.push(row);
    if (batch.length === 1_000) {
      flush();
    }
  }
  flush();
}

function* fixtureRows(count: number, row: (n: number) => readonly SQLInputValue[]) {
  for (let n = 1; n <= count; n++) {
    yield row(n);
  }
}

function orderedOwnerRead<T>(
  db: EngineConnection,
  matches: (sql: string) => boolean,
  index: string,
  operation: () => T,
): T {
  if (!isPostgresSqlConnection(db)) {
    return operation();
  }
  const query = db.query.bind(db);
  let plan: string[] | undefined;
  const capture = vi.spyOn(db, "query").mockImplementation((sql, parameters = []) => {
    if (!plan && matches(sql)) {
      // EXPLAIN without ANALYZE leaves the owner's DELETE as the only mutation.
      plan = query(`EXPLAIN ${sql}`, parameters).rows.map((row) => String(row["QUERY PLAN"]));
    }
    return query(sql, parameters);
  });
  let result: T;
  try {
    result = operation();
  } finally {
    capture.mockRestore();
  }
  expect(plan, "The real owner must execute the measured statement").toBeDefined();
  const text = plan!.join("\n");
  expect(text).toContain(index);
  expect(text).not.toMatch(/\b(?:Incremental )?Sort\b/u);
  return result;
}

type JournalResult = {
  launchPruned: number;
  turnAction: string;
  launchPlan?: string[];
  turnPlan?: string[];
};

// A single source worker captures the real kernel statements; the host retains its live grant.
async function readJournalPlans(
  state: ReturnType<typeof openOpenClawStateDatabase>,
  retainCleanup: (cleanup: () => Promise<void>) => void,
) {
  const context = admit(() => captureOpenClawStateWorkerContext({ path: state.path }));
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
    context.admission.assertCurrent();
    grant();
  });
  admission.bindDatabaseAuthority({
    databasePath: context.admission.databasePath,
    assertAccess: context.admission.assertCurrent,
    acquireSchema: () => acquireStateDatabaseSchemaLease(context.admission.databasePath),
  });
  const modules = {
    context: new URL("./context.ts", import.meta.url).href,
    admissions: new URL("../sqlite-database-admission.ts", import.meta.url).href,
    operation: new URL("../sqlite-worker-operation-scope.ts", import.meta.url).href,
    stateContext: new URL("../sqlite-worker-state-context.ts", import.meta.url).href,
    state: new URL("../../state/openclaw-state-db.ts", import.meta.url).href,
    launch: new URL("../../node-host/node-worker-launch-store.kernel.ts", import.meta.url).href,
    turn: new URL("../../node-host/node-worker-turn-store.kernel.ts", import.meta.url).href,
    connection: new URL("../sql-connection.ts", import.meta.url).href,
  };
  // The eval worker inherits the host pool instead of self-rooting four I/O services.
  const postgresPool = createPostgresPoolEndpoints();
  let worker: Worker;
  try {
    worker = new Worker(
      `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      const { register } = await import(workerData.loader);
      register();
      const load = (name) => import(workerData.modules[name]);
      const { installDatabaseEngineSelection } = await load("context");
      const { installSqliteDatabaseAdmissions } = await load("admissions");
      const { withSqliteWorkerOperationAdmission } = await load("operation");
      const { runWithSqliteWorkerStateContext } = await load("stateContext");
      const { openOpenClawStateDatabase, closeOpenClawStateDatabase } = await load("state");
      const { NodeWorkerLaunchKernel } = await load("launch");
      const { NodeWorkerTurnKernel } = await load("turn");
      const { isPostgresSqlConnection } = await load("connection");
      installDatabaseEngineSelection(workerData.stateContext.databaseEngineSelection);
      installSqliteDatabaseAdmissions(workerData.admissions);
      const response = runWithSqliteWorkerStateContext(workerData.stateContext, () =>
        withSqliteWorkerOperationAdmission({ port: workerData.port }, () => {
          const options = { path: workerData.path, env: workerData.stateContext.environment };
          const database = openOpenClawStateDatabase(options);
          const launches = new NodeWorkerLaunchKernel({ ...options, database });
          const turns = new NodeWorkerTurnKernel({ ...options, database });
          const plans = {};
          const original = isPostgresSqlConnection(database.db) && database.db.query.bind(database.db);
          if (original) {
            database.db.query = (sql, parameters = []) => {
              const kind = sql.startsWith("select") && sql.includes('from "node_worker_launches"') && sql.includes('order by "completed_at_ms"')
                ? "launchPlan"
                : sql.startsWith('delete from "node_worker_turns"') ? "turnPlan" : undefined;
              if (kind && !plans[kind]) {
                // The owner remains the sole writer: EXPLAIN never executes the DELETE.
                plans[kind] = original("EXPLAIN " + sql, parameters).rows.map((row) => String(row["QUERY PLAN"]));
              }
              return original(sql, parameters);
            };
          }
          try {
            const launchPruned = launches.pruneExpiredTerminal({ nowMs: workerData.now, limit: 1 });
            const turnAction = turns.claim({ claim: workerData.claim, ownerLaunchId: workerData.claim.launchId,
              supervisor: workerData.supervisor, nowMs: workerData.now }).action;
            return { launchPruned, turnAction, ...plans };
          } finally {
            if (original) database.db.query = original;
            closeOpenClawStateDatabase();
          }
        }),
      );
      workerData.port.close();
      parentPort.postMessage(response);
      parentPort.close();
    })().catch((error) => {
      workerData.port.close();
      parentPort.postMessage({ error: error.stack ?? String(error) });
      parentPort.close();
    });
  `,
      {
        eval: true,
        execArgv: [],
        workerData: {
          loader: import.meta.resolve("tsx/esm/api"),
          modules,
          path: state.path,
          claim,
          now,
          supervisor: requireNodeWorkerProcessIdentity(process.pid),
          stateContext: captureSqliteWorkerStateContext(context),
          admissions: captureSqliteDatabaseAdmissions(),
          port: admission.port,
          postgresPool,
        },
        transferList: [admission.port, ...postgresPoolTransferList(postgresPool)],
      },
    );
  } catch (error) {
    postgresPoolTransferList(postgresPool).forEach((port) => port.close());
    admission.finish();
    throw error;
  }
  let cleanup: Promise<void> | undefined;
  const stop = () =>
    (cleanup ??= worker
      .terminate()
      .then(() => undefined)
      .finally(() => admission.finish()));
  retainCleanup(stop);
  try {
    return await conformanceWorkerResult<JournalResult>(worker, "Partial-index journal");
  } finally {
    await stop();
  }
}

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} partial-index ordering through production owners`,
    () => {
      useMixedAgentPair(engine, engine);
      let state: ReturnType<typeof openOpenClawStateDatabase>;
      let agent: ReturnType<typeof openOpenClawAgentDatabase>;
      let journalResult: JournalResult;
      let cleanupJournal: (() => Promise<void>) | undefined;
      afterAll(async () => cleanupJournal?.());
      const supervisor = requireNodeWorkerProcessIdentity(process.pid);
      const count = engine === "postgres" ? 50_000 : 512;

      beforeAll(async () => {
        admit(() => {
          state = openOpenClawStateDatabase();
          agent = openOpenClawAgentDatabase({ agentId: "main" });
        });
        const journal = new NodeWorkerJournalWorker({ path: state.path });
        try {
          await new NodeWorkerLaunchStore(journal).claim(claim, supervisor, 1, now);
          await new NodeWorkerTurnStore(journal).claim({
            claim,
            ownerLaunchId: claim.launchId,
            supervisor,
            nowMs: now,
          });
        } finally {
          await journal.drain();
        }
        admit(() => {
          runSqliteImmediateTransactionSync(agent.db, () => {
            insertRows(
              agent.db,
              "session_nodes",
              [
                "session_key",
                "current_session_id",
                "entry_json",
                "entry_valid",
                "updated_at",
                "archived_at",
              ],
              fixtureRows(count, (n) => {
                const archivedAt = n === count ? null : Math.ceil(n / 2);
                return [
                  key(n),
                  `session-${n}`,
                  JSON.stringify({
                    sessionId: `session-${n}`,
                    updatedAt: 1,
                    ...(archivedAt === null
                      ? {}
                      : { archivedAt, archiveReason: "active-session-cap" }),
                  }),
                  1,
                  1,
                  archivedAt,
                ];
              }),
            );
            insertRows(
              agent.db,
              "session_entry_snapshots",
              ["session_key", "field", "value_json"],
              [
                [key(1), "sessionDiffBaseline", '{"marker":"baseline"}'],
                [key(1), "skillsSnapshot", '{"prompt":"synthetic prompt","skills":[]}'],
                [key(1), "systemPromptReport", '{"marker":"report"}'],
              ],
            );
            insertRows(
              agent.db,
              "session_windows",
              ["session_id", "session_key", "created_at", "updated_at"],
              [["partial-history", key(1), 0, 0]],
            );
            insertRows(
              agent.db,
              "transcript_events",
              ["session_id", "seq", "event_json", "created_at"],
              fixtureRows(count, (n) => [
                "partial-history",
                n,
                JSON.stringify({
                  type: "message",
                  id: `message-${n}`,
                  message: { role: "user", content: `payload-${n}` },
                }),
                n,
              ]),
            );
            insertRows(
              agent.db,
              "session_transcript_active_events",
              [
                "session_id",
                "active_position",
                "event_seq",
                "message_position",
                "context_eligible",
              ],
              fixtureRows(count, (n) => ["partial-history", n, n, n % 5 === 0 ? null : n, 1]),
            );
          });
          runSqliteImmediateTransactionSync(state.db, () => {
            const presentation = JSON.stringify(createExecApprovalPresentation("echo synthetic"));
            const approvalRow = (id: string, cursor: number, resolved: number | null) => [
              cursor,
              id,
              buildApprovalResolutionRef({ approvalId: id, approvalKind: "exec" }),
              "exec",
              resolved === null ? "pending" : "denied",
              presentation,
              "[]",
              "[]",
              "partial-runtime",
              0,
              now,
              resolved ?? now,
              resolved === null ? null : "deny",
              resolved === null ? null : "user",
              resolved,
              resolved === null ? null : "system",
            ];
            insertRows(
              state.db,
              "operator_approvals",
              [
                "cursor_id",
                "approval_id",
                "resolution_ref",
                "kind",
                "status",
                "presentation_json",
                "reviewer_device_ids_json",
                "audience_session_keys_json",
                "runtime_epoch",
                "created_at_ms",
                "expires_at_ms",
                "updated_at_ms",
                "decision",
                "terminal_reason",
                "resolved_at_ms",
                "resolver_kind",
              ],
              (function* () {
                yield* fixtureRows(count, (n) =>
                  approvalRow(`approval-${n}`, n, n === count ? null : n),
                );
                yield approvalRow("approval-latest-a", count + 1, now - 1);
                yield approvalRow("approval-latest-b", count + 2, now - 1);
              })(),
            );
            insertRows(
              state.db,
              "node_worker_launches",
              [
                "launch_id",
                "plan_hash",
                "gateway_namespace",
                "environment_id",
                "session_id",
                "owner_epoch",
                "placement_generation",
                "run_id",
                "state",
                "supervisor_pid",
                "supervisor_start_time",
                "result_json",
                "completed_at_ms",
                "created_at_ms",
                "updated_at_ms",
              ],
              fixtureRows(count, (n) => [
                `launch-${n}`,
                claim.planHash,
                "partial-gateway",
                `environment-${n}`,
                `session-${n}`,
                1,
                1,
                `run-${n}`,
                n === count ? "pending" : "completed",
                supervisor.pid,
                supervisor.startTime,
                n === count ? null : "{}",
                n === count ? null : Math.ceil(n / 2),
                0,
                n,
              ]),
            );
            insertRows(
              state.db,
              "node_worker_turns",
              [
                "turn_id",
                "owner_launch_id",
                "plan_hash",
                "run_id",
                "state",
                "result_json",
                "completed_at_ms",
                "created_at_ms",
                "updated_at_ms",
              ],
              fixtureRows(count, (n) => [
                `turn-${n}`,
                claim.launchId,
                claim.planHash,
                `run-${n}`,
                "completed",
                "{}",
                n,
                0,
                n,
              ]),
            );
          });
          if (engine === "postgres") {
            for (const table of [
              "session_nodes",
              "session_entry_snapshots",
              "transcript_events",
              "session_transcript_active_events",
            ]) {
              agent.db.exec(`VACUUM (ANALYZE) "${table}"`);
            }
            for (const table of [
              "operator_approvals",
              "node_worker_launches",
              "node_worker_turns",
            ]) {
              state.db.exec(`VACUUM (ANALYZE) "${table}"`);
            }
          }
        });
        journalResult = await readJournalPlans(state, (cleanup) => {
          cleanupJournal = cleanup;
        });
      });

      it("pages tied archived entries with their full cold snapshots", () =>
        admit(() => {
          const first = orderedOwnerRead(
            agent.db,
            (sql) => sql.startsWith("select") && sql.includes('"archived_at" is not null'),
            "idx_agent_session_nodes_archived_at",
            () =>
              readDiskEvictableArchivedSessionBatchInDatabase(agent, {
                liveSessionKeys: [],
                limit: 2,
              }),
          );
          expect(first.candidates.map((row) => row.sessionKey)).toEqual([key(1), key(2)]);
          expect(first.candidates[0]?.entry).toMatchObject({
            sessionDiffBaseline: { marker: "baseline" },
            skillsSnapshot: { prompt: "synthetic prompt", skills: [] },
            systemPromptReport: { marker: "report" },
          });
          const next = readDiskEvictableArchivedSessionBatchInDatabase(agent, {
            liveSessionKeys: [],
            limit: 2,
            after: first.cursor,
          });
          expect(next.candidates.map((row) => row.sessionKey)).toEqual([key(3), key(4)]);
        }));

      it("reads the latest bounded message payload through its ordered partial index", () =>
        admit(() => {
          const row = orderedOwnerRead(
            agent.db,
            (sql) =>
              sql.startsWith("select") &&
              sql.includes('"active"."message_position"') &&
              sql.includes("desc"),
            "idx_agent_transcript_active_messages",
            () =>
              getMessageRangeReaders(agent).latest({
                sessionId: "partial-history",
                start: 100,
                endExclusive: 200,
              }),
          );
          expect(row?.message_position).toBe(199);
          expect(JSON.parse(row!.event_json!)).toMatchObject({
            id: "message-199",
            message: { content: "payload-199" },
          });
          expect(
            [
              ...getMessageRangeReaders(agent).messages({
                sessionId: "partial-history",
                start: 100,
                endExclusive: 105,
              }),
            ].map((message) => message.message_position),
          ).toEqual([101, 102, 103, 104]);
        }));

      it("lists resolved approvals newest first without sorting the unscoped archive", () =>
        admit(() => {
          const result = orderedOwnerRead(
            state.db,
            (sql) => sql.startsWith("select") && sql.includes('"resolved_at_ms" is not null'),
            "idx_operator_approvals_resolved",
            () => listTerminalOperatorApprovalsInDatabase({ limit: 1, nowMs: now }, state.db),
          );
          expect(result.records.map((record) => record.id)).toEqual(["approval-latest-b"]);
          expect(result.nextCursor).toBeDefined();
        }));

      it("prunes the oldest tied launch while retaining pending and later receipts", () => {
        const { launchPruned, launchPlan } = journalResult;
        expect(launchPruned).toBe(1);
        if (engine === "postgres") {
          expect(launchPlan?.join("\n")).toContain("idx_node_worker_launches_terminal_completed");
          expect(launchPlan?.join("\n")).not.toMatch(/\b(?:Incremental )?Sort\b/u);
        }
        admit(() => {
          expect(
            state.db
              .prepare("SELECT launch_id FROM node_worker_launches WHERE launch_id = ?")
              .get("launch-1"),
          ).toBeUndefined();
          expect(
            state.db
              .prepare("SELECT launch_id FROM node_worker_launches WHERE launch_id = ?")
              .get("launch-2"),
          ).toEqual({ launch_id: "launch-2" });
          expect(
            state.db
              .prepare("SELECT state FROM node_worker_launches WHERE launch_id = ?")
              .get(`launch-${count}`),
          ).toEqual({ state: "pending" });
        });
      });

      it("prunes a bounded turn batch with an index-only candidate read and keeps the current replay", () => {
        const { turnAction, turnPlan } = journalResult;
        expect(turnAction).toBe("replay");
        if (engine === "postgres") {
          expect(turnPlan?.join("\n")).toMatch(
            /Index Only Scan[^\n]*idx_node_worker_turns_terminal_completed/u,
          );
          expect(turnPlan?.join("\n")).not.toMatch(/\b(?:Incremental )?Sort\b/u);
        }
        admit(() => {
          expect(state.db.prepare("SELECT count(*) AS count FROM node_worker_turns").get()).toEqual(
            { count: count - 256 + 1 },
          );
          expect(
            state.db
              .prepare("SELECT turn_id FROM node_worker_turns WHERE turn_id = ?")
              .get("turn-257"),
          ).toEqual({ turn_id: "turn-257" });
          expect(
            state.db
              .prepare("SELECT state FROM node_worker_turns WHERE turn_id = ?")
              .get(claim.launchId),
          ).toEqual({ state: "running" });
        });
      });
    },
  );
}
