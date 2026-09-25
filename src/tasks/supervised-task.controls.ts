import { createHash } from "node:crypto";
import { z } from "zod";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { readTask, replaceTask } from "./supervised-task.persistence.js";
import {
  cancelSupervisedTaskInTransaction,
  getSupervisedTask,
  resumeSupervisedTaskInTransaction,
} from "./supervised-task.store.js";
import { SupervisedPolicySchema, type SupervisedTask } from "./supervised-task.types.js";
import {
  writeSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
import { readSupervisedWorkflowContractInTransaction } from "./supervised-workflow.store.js";
import { readSupervisedWorkspaceHeadInTransaction } from "./supervised-workspace-versions.js";
const id = z.string().min(1).max(128);
const text = z.string().min(1).max(4096);
const Action = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("cancel") }),
  z.strictObject({ kind: z.literal("steer"), input: text }),
  z.strictObject({ kind: z.literal("resume"), input: text, policy: SupervisedPolicySchema }),
  z.strictObject({
    kind: z.literal("approve"),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    criterionIds: z.array(id).min(1).max(32),
  }),
]);
export const SupervisedTaskControlSchema = z.strictObject({
  flowId: id,
  episode: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  inputId: id,
  action: Action,
});

// The durable receipt is an acknowledgement, not a copy of the up-to-64-KiB
// task. It remains bounded by the existing 8-KiB input record contract.
const ControlAcknowledgementSchema = z.strictObject({
  flowId: id,
  episode: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  phase: z.enum([
    "ready",
    "waiting",
    "running",
    "succeeded",
    "partial",
    "input_required",
    "failed",
    "cancelled",
  ]),
});
export type SupervisedTaskControlAcknowledgement = z.infer<typeof ControlAcknowledgementSchema>;

export class SupervisedTaskControlReplayUnavailableError extends Error {
  constructor() {
    super(
      "This control was already recorded, but its original acknowledgement is unavailable. Refresh task state; do not submit it again as a new control.",
    );
    this.name = "SupervisedTaskControlReplayUnavailableError";
  }
}

/** Typed operator controls. Gateways must supply current write authorization;
 * model output cannot call this owner seam or manufacture its actor identity. */
export function controlSupervisedTask(
  value: unknown,
  authority: {
    actorId: string;
    assertCurrent: (task: SupervisedTask) => void;
    supervisorOwnerId?: string;
  },
  now: number,
  options: Options = {},
): SupervisedTaskControlAcknowledgement {
  const request = SupervisedTaskControlSchema.parse(value);
  const actor = id.parse(authority.actorId);
  const visible = getSupervisedTask(request.flowId, options);
  if (!visible) {
    throw new Error("Unknown supervised task");
  }
  authority.assertCurrent(visible);
  const key = createHash("sha256")
    .update(JSON.stringify(["supervised-control", actor, request.inputId]))
    .digest("hex");
  const json = JSON.stringify(request);
  if (Buffer.byteLength(json) > 8192) {
    throw new Error("Control input exceeds its serialized byte budget");
  }
  const fingerprint = createHash("sha256").update(json).digest("hex");
  return writeSupervisedWorkflow((db) => {
    const task = readTask(db, request.flowId);
    if (!task) {
      throw new Error("Task no longer exists");
    }
    authority.assertCurrent(task);
    const sql = getNodeSqliteKysely<DB>(db);
    const replay = executeSqliteQueryTakeFirstSync(
      db,
      sql.selectFrom("task_flow_inputs").selectAll().where("source_key", "=", key),
    );
    if (replay) {
      if (replay.fingerprint !== fingerprint || replay.flow_id !== task.flowId) {
        throw new Error("Control input ID reused with changed input");
      }
      // Request-only receipts from an earlier development build cannot recreate
      // the original response. Never turn current state into a fabricated replay.
      const recorded = ControlAcknowledgementSchema.safeParse(
        replay.record_json ? JSON.parse(replay.record_json) : null,
      );
      if (!recorded.success) {
        throw new SupervisedTaskControlReplayUnavailableError();
      }
      if (recorded.data.flowId !== replay.flow_id || recorded.data.episode !== replay.episode) {
        throw new Error("Control acknowledgement disagrees with its receipt");
      }
      return recorded.data;
    }
    if (task.episode !== request.episode || task.revision !== request.revision) {
      throw new Error("Task changed since this control was prepared; refresh its state");
    }
    let result = task;
    const action = request.action;
    if (action.kind === "cancel") {
      result = cancelSupervisedTaskInTransaction(db, task.flowId, now);
    } else if (action.kind === "resume") {
      if (!authority.supervisorOwnerId) {
        throw new Error("Resume requires native supervisor custody");
      }
      result = resumeSupervisedTaskInTransaction(
        db,
        task.flowId,
        task.episode,
        action.input,
        action.policy,
        authority.supervisorOwnerId,
        now,
      );
    } else if (action.kind === "steer") {
      if (!readSupervisedWorkflowContractInTransaction(db, task.flowId, task.episode)) {
        throw new Error("Steering requires an isolated managed workflow");
      }
      if (task.endpoint || task.policy.deadlineAt <= now) {
        throw new Error("Steering requires an active unexpired episode");
      }
      const pending = executeSqliteQueryTakeFirstSync(
        db,
        sql
          .selectFrom("task_flow_operations")
          .select("operation_id")
          .where("flow_id", "=", task.flowId)
          .where("episode", "=", task.episode)
          .where("state", "in", ["queued", "running", "reconciling"]),
      );
      // Model attempts use disposable drafts; revocation cannot promote their
      // late writes. Already accepted independent operations keep their receipts.
      result = replaceTask(db, task, {
        ...task,
        attempt: null,
        phase: pending ? "waiting" : "ready",
        next: action.input,
        dueAt: pending ? task.dueAt : now,
        updatedAt: now,
      });
    } else {
      const contract = readSupervisedWorkflowContractInTransaction(db, task.flowId, task.episode);
      const head = readSupervisedWorkspaceHeadInTransaction(db, task.flowId, task.episode);
      if (!contract || !head || head.source_hash !== action.sourceHash) {
        throw new Error("Operator acceptance requires the exact retained artifact");
      }
      for (const criterion of new Set(action.criterionIds)) {
        if (
          !contract.contract.acceptance.some(
            (rule) => rule.criterionId === criterion && rule.kind === "operator",
          )
        ) {
          throw new Error("Operator cannot replace a required automated check");
        }
        executeSqliteQuerySync(
          db,
          sql.insertInto("task_flow_operator_acceptance").values({
            approval_id: `${key}:${criterion}`,
            flow_id: task.flowId,
            episode: task.episode,
            criterion_id: criterion,
            contract_hash: contract.hash,
            source_hash: head.source_hash,
            actor_id: actor,
            accepted_at_ms: now,
          }),
        );
      }
    }
    const disposition =
      action.kind === "cancel"
        ? "cancelled"
        : action.kind === "resume"
          ? "resumed"
          : action.kind === "steer"
            ? "steered"
            : "approved";
    const acknowledgement: SupervisedTaskControlAcknowledgement = {
      flowId: result.flowId,
      episode: result.episode,
      revision: result.revision,
      phase: result.phase,
    };
    executeSqliteQuerySync(
      db,
      sql.insertInto("task_flow_inputs").values({
        source_key: key,
        fingerprint,
        flow_id: task.flowId,
        episode: result.episode,
        disposition,
        created_at_ms: now,
        record_json: JSON.stringify(acknowledgement),
      }),
    );
    return acknowledgement;
  }, options);
}
