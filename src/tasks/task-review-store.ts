// Atomically couples managed-flow review state with its canonical reviewer task.
import type { Insertable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { JsonValue, TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

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
          blocked_task_id: null,
          blocked_summary: null,
          ended_at: null,
          wait_json: null,
          cancel_requested_at: null,
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

export type AtomicReviewMutationResult =
  | { status: "applied" }
  | { status: "task_conflict" }
  | { status: "flow_missing" };

class ReviewMutationConflict extends Error {
  constructor(readonly result: Exclude<AtomicReviewMutationResult, { status: "applied" }>) {
    super(result.status);
  }
}

function parseStateJson(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Managed review flow state must be an object.");
  }
  return parsed as Record<string, unknown>;
}

export function bindReviewLaunchAtomically(params: {
  task: TaskRecord;
  expectedDetail: JsonValue;
  expectedAttempt: number;
  expectedClaimedAt: number;
  nextDetail: JsonValue;
  childSessionKey: string;
  now: number;
}): AtomicReviewMutationResult {
  const expected = JSON.stringify(params.expectedDetail);
  const expectedRecord =
    params.expectedDetail &&
    typeof params.expectedDetail === "object" &&
    !Array.isArray(params.expectedDetail)
      ? params.expectedDetail
      : undefined;
  const launch =
    expectedRecord?.launch &&
    typeof expectedRecord.launch === "object" &&
    !Array.isArray(expectedRecord.launch)
      ? expectedRecord.launch
      : undefined;
  if (
    launch?.phase !== "claimed" ||
    launch.attempt !== params.expectedAttempt ||
    launch.claimedAt !== params.expectedClaimedAt
  ) {
    throw new Error("Launch binding claim metadata does not match its raw detail snapshot.");
  }
  const { db } = openOpenClawStateDatabase();
  const store = getNodeSqliteKysely<ReviewStoreDatabase>(db);
  const updated = executeSqliteQuerySync(
    db,
    store
      .updateTable("task_runs")
      .set({
        child_session_key: params.childSessionKey,
        status: "running",
        started_at: params.task.startedAt ?? params.now,
        last_event_at: params.now,
        progress_summary: "Reviewer child is running.",
        detail_json: JSON.stringify(params.nextDetail),
      })
      .where("task_id", "=", params.task.taskId)
      .where("runtime", "=", params.task.runtime)
      .where("detail_json", "=", expected),
  );
  return updated.numAffectedRows === 1n ? { status: "applied" } : { status: "task_conflict" };
}

export function commitReviewTaskAndFlowAtomically(params: {
  task: TaskRecord;
  expectedDetail: JsonValue;
  nextTask: TaskRecord;
  reviewProjection: JsonValue;
  flowStatus: TaskFlowRecord["status"];
  currentStep: string;
  blockedSummary?: string;
  flowEndedAt?: number;
  now: number;
}): AtomicReviewMutationResult {
  if (!params.task.parentFlowId) {
    return { status: "flow_missing" };
  }
  const { db } = openOpenClawStateDatabase();
  const store = getNodeSqliteKysely<ReviewStoreDatabase>(db);
  try {
    return runOpenClawStateWriteTransaction(() => {
      const flow = executeSqliteQuerySync(
        db,
        store
          .selectFrom("flow_runs")
          .select(["revision", "state_json"])
          .where("flow_id", "=", params.task.parentFlowId!)
          .where("owner_key", "=", params.task.ownerKey)
          .where("sync_mode", "=", "managed"),
      ).rows[0];
      if (!flow) {
        throw new ReviewMutationConflict({ status: "flow_missing" });
      }
      const state = parseStateJson(flow.state_json);
      const taskUpdate = executeSqliteQuerySync(
        db,
        store
          .updateTable("task_runs")
          .set({
            child_session_key: params.nextTask.childSessionKey ?? null,
            status: params.nextTask.status,
            started_at: params.nextTask.startedAt ?? null,
            ended_at: params.nextTask.endedAt ?? null,
            last_event_at: params.nextTask.lastEventAt ?? null,
            error: params.nextTask.error ?? null,
            progress_summary: params.nextTask.progressSummary ?? null,
            terminal_summary: params.nextTask.terminalSummary ?? null,
            terminal_outcome: params.nextTask.terminalOutcome ?? null,
            detail_json:
              params.nextTask.detail === undefined ? null : JSON.stringify(params.nextTask.detail),
          })
          .where("task_id", "=", params.task.taskId)
          .where("runtime", "=", params.task.runtime)
          .where("detail_json", "=", JSON.stringify(params.expectedDetail)),
      );
      if (taskUpdate.numAffectedRows !== 1n) {
        throw new ReviewMutationConflict({ status: "task_conflict" });
      }
      const flowUpdate = executeSqliteQuerySync(
        db,
        store
          .updateTable("flow_runs")
          .set({
            revision: flow.revision + 1,
            status: params.flowStatus,
            current_step: params.currentStep,
            blocked_task_id: params.blockedSummary ? params.task.taskId : null,
            blocked_summary: params.blockedSummary ?? null,
            ended_at: params.flowEndedAt ?? null,
            wait_json: null,
            cancel_requested_at: null,
            state_json: JSON.stringify({ ...state, review: params.reviewProjection }),
            updated_at: params.now,
          })
          .where("flow_id", "=", params.task.parentFlowId!)
          .where("revision", "=", flow.revision),
      );
      if (flowUpdate.numAffectedRows !== 1n) {
        throw new Error("Managed review flow revision changed inside its write transaction.");
      }
      return { status: "applied" } as const;
    });
  } catch (error) {
    if (error instanceof ReviewMutationConflict) {
      return error.result;
    }
    throw error;
  }
}
