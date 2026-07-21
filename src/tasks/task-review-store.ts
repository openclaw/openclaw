// Atomically couples managed-flow review state with its canonical reviewer task.
import type { Insertable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

type ReviewStoreDatabase = Pick<
  OpenClawStateDatabase,
  "flow_runs" | "task_delivery_state" | "task_runs"
>;

function bindTask(task: TaskRecord): Insertable<OpenClawStateDatabase["task_runs"]> {
  return {
    task_id: task.taskId,
    runtime: task.runtime,
    task_kind: task.taskKind ?? null,
    source_id: task.sourceId ?? null,
    requester_session_key: task.requesterSessionKey,
    owner_key: task.ownerKey,
    scope_kind: task.scopeKind,
    child_session_key: task.childSessionKey ?? null,
    parent_flow_id: task.parentFlowId ?? null,
    parent_task_id: task.parentTaskId ?? null,
    agent_id: task.agentId ?? null,
    requester_agent_id: task.requesterAgentId ?? null,
    run_id: task.runId ?? null,
    label: task.label ?? null,
    task: task.task,
    status: task.status,
    delivery_status: task.deliveryStatus,
    notify_policy: task.notifyPolicy,
    created_at: task.createdAt,
    started_at: task.startedAt ?? null,
    ended_at: task.endedAt ?? null,
    last_event_at: task.lastEventAt ?? null,
    cleanup_after: task.cleanupAfter ?? null,
    tool_use_count: task.toolUseCount ?? null,
    last_tool_name: task.lastToolName ?? null,
    error: task.error ?? null,
    progress_summary: task.progressSummary ?? null,
    terminal_summary: task.terminalSummary ?? null,
    terminal_outcome: task.terminalOutcome ?? null,
    detail_json: task.detail === undefined ? null : JSON.stringify(task.detail),
  };
}

export type AtomicReviewDispatchResult =
  | { status: "created" }
  | { status: "existing" }
  | { status: "flow_conflict" };

export function createReviewDispatchAtomically(params: {
  flow: TaskFlowRecord;
  expectedRevision: number;
  nextStateJson: TaskFlowRecord["stateJson"];
  task: TaskRecord;
  deliveryState?: TaskDeliveryState;
}): AtomicReviewDispatchResult {
  const { db } = openOpenClawStateDatabase();
  const store = getNodeSqliteKysely<ReviewStoreDatabase>(db);
  return runOpenClawStateWriteTransaction(() => {
    const existing = executeSqliteQuerySync(
      db,
      store.selectFrom("task_runs").select(["task_id"]).where("task_id", "=", params.task.taskId),
    ).rows[0];
    if (existing) {
      return { status: "existing" } as const;
    }

    const flowUpdate = executeSqliteQuerySync(
      db,
      store
        .updateTable("flow_runs")
        .set({
          revision: params.expectedRevision + 1,
          status: "waiting",
          current_step: "review_pending",
          state_json:
            params.nextStateJson === undefined ? null : JSON.stringify(params.nextStateJson),
          updated_at: params.task.createdAt,
        })
        .where("flow_id", "=", params.flow.flowId)
        .where("owner_key", "=", params.flow.ownerKey)
        .where("sync_mode", "=", "managed")
        .where("revision", "=", params.expectedRevision),
    );
    if (flowUpdate.numAffectedRows !== 1n) {
      return { status: "flow_conflict" } as const;
    }

    executeSqliteQuerySync(db, store.insertInto("task_runs").values(bindTask(params.task)));
    if (params.deliveryState) {
      executeSqliteQuerySync(
        db,
        store.insertInto("task_delivery_state").values({
          task_id: params.task.taskId,
          requester_origin_json: params.deliveryState.requesterOrigin
            ? JSON.stringify(params.deliveryState.requesterOrigin)
            : null,
          last_notified_event_at: params.deliveryState.lastNotifiedEventAt ?? null,
        }),
      );
    }
    return { status: "created" } as const;
  });
}
