import type { DB } from "../state/openclaw-state-db.generated.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { GatewayRestartHandoff } from "./restart-lifecycle.types.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";

export const restartLifecycleOperations = {
  "restartLifecycle.consumeIntent": (_input: undefined, { write }) =>
    write(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const stateDb = getNodeSqliteKysely<Pick<DB, "gateway_restart_intent">>(db);
        const row = executeSqliteQueryTakeFirstSync(
          db,
          stateDb
            .deleteFrom("gateway_restart_intent")
            .where("intent_key", "=", "gateway-restart")
            .returning(["kind", "pid", "created_at", "reason", "force", "wait_ms"]),
        );
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        deferSqliteWorkerCommitReceipt(db, { kind: "restart-intent-consumed", row });
        return row;
      },
      { operationLabel: "gateway.restart-intent.consume" },
    ),
  "restartLifecycle.writeHandoff": (payload: GatewayRestartHandoff, { write }) =>
    write(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const stateDb = getNodeSqliteKysely<Pick<DB, "gateway_restart_handoff">>(db);
        const row = {
          kind: payload.kind,
          version: payload.version,
          intent_id: payload.intentId,
          pid: payload.pid,
          process_instance_id: payload.processInstanceId ?? null,
          created_at: payload.createdAt,
          expires_at: payload.expiresAt,
          reason: payload.reason ?? null,
          restart_trace_started_at: payload.restartTrace?.startedAt ?? null,
          restart_trace_last_at: payload.restartTrace?.lastAt ?? null,
          source: payload.source,
          restart_kind: payload.restartKind,
          supervisor_mode: payload.supervisorMode,
          updated_at_ms: Date.now(),
        };
        executeSqliteQuerySync(
          db,
          stateDb
            .insertInto("gateway_restart_handoff")
            .values({ handoff_key: "current", ...row })
            .onConflict((conflict) => conflict.column("handoff_key").doUpdateSet(row)),
        );
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        deferSqliteWorkerCommitReceipt(db, payload);
      },
      { operationLabel: "gateway.restart-handoff.write" },
    ),
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;

export type RestartLifecycleWorkerOperations = WorkerOperations<typeof restartLifecycleOperations>;
