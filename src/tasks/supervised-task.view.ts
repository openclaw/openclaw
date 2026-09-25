import { z } from "zod";
import type { SupervisionSummary } from "../../packages/gateway-protocol/src/schema/tasks-supervision.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { parseSupervisedOperation } from "./supervised-operation.types.js";
import { readSupervisedOperatorAcceptance } from "./supervised-operator-acceptance.js";
import { decodeTaskRow } from "./supervised-task.persistence.js";
import { readSupervisedRecoveryInTransaction } from "./supervised-task.recovery.js";
import {
  readSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
import { readSupervisedWorkflowContractInTransaction } from "./supervised-workflow.store.js";
import { readSupervisedWorkspaceHeadInTransaction } from "./supervised-workspace-versions.js";

/** Read-only projection, including corrupt quarantined episodes. It never
 * materializes state, executes a task, or converts delivery into task outcome. */
export function getSupervisedTaskView(
  flowId: string,
  now: number,
  options: Options = {},
): SupervisionSummary | undefined {
  return readSupervisedWorkflow<SupervisionSummary | undefined>((db) => {
    if (!tableExists(db, "task_flow_episodes")) {
      return undefined;
    }
    const sql = getNodeSqliteKysely<DB>(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      sql
        .selectFrom("task_flow_episodes")
        .selectAll()
        .where("flow_id", "=", flowId)
        .orderBy("episode", "desc")
        .limit(1),
    );
    if (!row) {
      return undefined;
    }
    let task;
    try {
      task = decodeTaskRow(row);
    } catch {
      /* Original bytes remain available to repair, not to the public view. */
    }
    const fault = readSupervisedRecoveryInTransaction(db, flowId, row.episode)?.fault_json;
    if (!task || fault) {
      return {
        flowId,
        episode: row.episode,
        revision: row.revision,
        agentId: task?.agentId ?? "unknown",
        ...(task ? { runtime: task.runtime } : {}),
        phase: "quarantined",
        continuation: "stopped",
        observedAt: now,
        supervisorExpiresAt: null,
        operatorRequired: true,
        title: "Stored task requires repair; original record retained",
        attempts: task?.attempts ?? 0,
        maxAttempts: task?.policy.maxAttempts ?? 0,
        deadlineAt: row.deadline_at_ms,
        operatorCriteria: [],
        operations: [],
        notifications: [],
      };
    }
    const observer = executeSqliteQueryTakeFirstSync(
      db,
      sql
        .selectFrom("task_flow_supervisors")
        .select("expires_at_ms")
        .where("stopped_at_ms", "is", null)
        .where("expires_at_ms", ">", now)
        .where((eb) => eb.or([eb("flow_id", "is", null), eb("flow_id", "=", flowId)]))
        .orderBy("expires_at_ms", "desc")
        .limit(1),
    );
    const contract = readSupervisedWorkflowContractInTransaction(db, flowId, task.episode);
    const head = readSupervisedWorkspaceHeadInTransaction(db, flowId, task.episode);
    const operations = tableExists(db, "task_flow_operations")
      ? executeSqliteQuerySync(
          db,
          sql
            .selectFrom("task_flow_operations")
            .selectAll()
            .where("flow_id", "=", flowId)
            .where("episode", "=", task.episode)
            .orderBy("operation_id")
            .limit(256),
        ).rows.map((operation) => {
          try {
            return {
              id: operation.operation_id,
              kind: parseSupervisedOperation(JSON.parse(operation.record_json)).request.kind,
              state: operation.state,
            };
          } catch {
            return { id: operation.operation_id, kind: "unknown", state: "quarantined" };
          }
        })
      : [];
    const notifications = tableExists(db, "task_flow_notifications")
      ? executeSqliteQuerySync(
          db,
          sql
            .selectFrom("task_flow_notifications")
            .selectAll()
            .where("flow_id", "=", flowId)
            .orderBy("created_at_ms", "desc")
            .orderBy("notification_id")
            .limit(32),
        ).rows.map((notification) => ({
          id: notification.notification_id,
          episode: notification.episode,
          state: z
            .enum(["pending", "queued", "delivered", "suppressed", "failed", "unknown"])
            .parse(notification.state),
          updatedAt: notification.updated_at_ms,
        }))
      : [];
    return {
      flowId,
      episode: task.episode,
      revision: task.revision,
      agentId: task.agentId,
      runtime: task.runtime,
      phase: task.phase,
      continuation: task.endpoint ? "stopped" : observer ? "armed" : "unknown",
      observedAt: now,
      supervisorExpiresAt: observer?.expires_at_ms ?? null,
      operatorRequired: task.phase === "input_required",
      title: task.goal?.objective ?? task.prompt,
      attempts: task.attempts,
      maxAttempts: task.policy.maxAttempts,
      deadlineAt: task.policy.deadlineAt,
      ...(task.endpoint
        ? {
            endpoint: {
              reason: task.endpoint.reason,
              ...(task.endpoint.question ? { question: task.endpoint.question } : {}),
              effects: task.endpoint.effects,
            },
          }
        : {}),
      ...(head ? { artifact: { versionId: head.version_id, sourceHash: head.source_hash } } : {}),
      operatorCriteria:
        contract?.contract.acceptance
          .filter((rule) => rule.kind === "operator")
          .map((rule) => ({
            criterionId: rule.criterionId,
            accepted: Boolean(
              head &&
              readSupervisedOperatorAcceptance(db, {
                flowId,
                criterionId: rule.criterionId,
                contractHash: contract.hash,
                sourceHash: head.source_hash,
              }),
            ),
          })) ?? [],
      operations,
      notifications,
    };
  }, options);
}

/** Stable keyset traversal scoped to one source session, never an unbounded
 * all-task decode. Authorization belongs to the caller before and after reads. */
export function listSupervisedTaskViewIds(
  params: { agentId: string; sessionKey: string; sessionId: string; after?: string; limit: number },
  options: Options = {},
) {
  return (
    readSupervisedWorkflow((db) => {
      if (!tableExists(db, "task_flow_sources")) {
        return [];
      }
      let query = getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_sources")
        .select("flow_id")
        .where("agent_id", "=", params.agentId)
        .where("session_key", "=", params.sessionKey)
        .where("session_id", "=", params.sessionId);
      if (params.after) {
        query = query.where("flow_id", ">", params.after);
      }
      return executeSqliteQuerySync(
        db,
        query.orderBy("flow_id").limit(Math.min(101, params.limit + 1)),
      ).rows.map((row) => row.flow_id);
    }, options) ?? []
  );
}
