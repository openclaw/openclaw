import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { SupervisedTask } from "./supervised-task.types.js";
import {
  readSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";

const text = z.string().min(1).max(2048);
export const SupervisedTaskSourceSchema = z
  .strictObject({
    agentId: z.string().min(1).max(128),
    sessionKey: text,
    sessionId: text,
    namespace: z.enum(["gateway", "channel", "local"]),
    inputId: text,
    // This denotes an authorized source-session scope, not inferred human identity.
    ownerScope: text,
    conversationRef: text.optional(),
    routeFingerprint: text.optional(),
  })
  .refine(
    (value) => Boolean(value.conversationRef) === Boolean(value.routeFingerprint),
    "Conversation delivery needs an exact route fingerprint",
  );
export type SupervisedTaskSource = z.infer<typeof SupervisedTaskSourceSchema>;
export const SupervisedRootHandledSchema = z.strictObject({
  kind: z.literal("handled"),
  control: z.enum(["status", "cancel", "steer", "resume"]).optional(),
  message: z.string().min(1).max(8192),
  flowId: z.string().max(128).optional(),
  episode: z.number().int().positive().optional(),
  replay: z.boolean(),
});
export type SupervisedRootHandled = z.infer<typeof SupervisedRootHandledSchema>;

export type SupervisedTaskAdmission = {
  source: SupervisedTaskSource;
  fingerprint: string;
  sourceKey: string;
  assertCurrent: () => void;
};

export function supervisedSourceInputKey(
  source: Pick<
    SupervisedTaskSource,
    "agentId" | "namespace" | "sessionKey" | "sessionId" | "inputId"
  >,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        source.agentId,
        source.namespace,
        source.sessionKey,
        source.sessionId,
        source.inputId,
      ]),
    )
    .digest("hex");
}
export function supervisedInputIdentity(source: SupervisedTaskSource, message: string) {
  const sourceKey = supervisedSourceInputKey(source);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ source, message }))
    .digest("hex");
  return { sourceKey, fingerprint };
}
export function readSupervisedInputReceipt(sourceKey: string, options: Options = {}) {
  return readSupervisedWorkflow(
    (db) =>
      tableExists(db, "task_flow_inputs")
        ? executeSqliteQueryTakeFirstSync(
            db,
            getNodeSqliteKysely<DB>(db)
              .selectFrom("task_flow_inputs")
              .selectAll()
              .where("source_key", "=", sourceKey),
          )
        : undefined,
    options,
  );
}
/** Recovery observes exact committed custody without classifying or executing
 * the original request a second time. Ordinary input has no such receipt. */
export function readSupervisedSourceHandoff(
  source: Parameters<typeof supervisedSourceInputKey>[0],
  options: Options = {},
) {
  const receipt = readSupervisedInputReceipt(supervisedSourceInputKey(source), options);
  if (!receipt || receipt.disposition === "ordinary") {
    return undefined;
  }
  if (receipt.record_json) {
    return { ...SupervisedRootHandledSchema.parse(JSON.parse(receipt.record_json)), replay: true };
  }
  if (receipt.disposition !== "admitted" || !receipt.flow_id || !receipt.episode) {
    throw new Error("Invalid supervised source handoff receipt");
  }
  const bound = getSupervisedTaskSource(receipt.flow_id, options);
  if (
    !bound ||
    bound.agentId !== source.agentId ||
    bound.sessionKey !== source.sessionKey ||
    bound.sessionId !== source.sessionId
  ) {
    throw new Error("Supervised handoff source no longer matches its receipt");
  }
  return {
    kind: "admitted" as const,
    flowId: receipt.flow_id,
    episode: receipt.episode,
    replay: true,
  };
}
export function insertSupervisedTaskSourceInTransaction(
  db: DatabaseSync,
  task: SupervisedTask,
  admission: SupervisedTaskAdmission,
) {
  admission.assertCurrent();
  const source = SupervisedTaskSourceSchema.parse(admission.source);
  if (
    source.agentId !== task.agentId ||
    !/^[a-f0-9]{64}$/.test(admission.fingerprint) ||
    !/^[a-f0-9]{64}$/.test(admission.sourceKey)
  ) {
    throw new Error("Invalid root task admission binding");
  }
  if (Buffer.byteLength(JSON.stringify(source)) > 16384) {
    throw new Error("Task source binding exceeds its byte budget");
  }
  const sql = getNodeSqliteKysely<DB>(db);
  executeSqliteQuerySync(
    db,
    sql.insertInto("task_flow_sources").values({
      flow_id: task.flowId,
      agent_id: task.agentId,
      session_key: source.sessionKey,
      session_id: source.sessionId,
      record_json: JSON.stringify(source),
    }),
  );
  executeSqliteQuerySync(
    db,
    sql.insertInto("task_flow_inputs").values({
      source_key: admission.sourceKey,
      fingerprint: admission.fingerprint,
      flow_id: task.flowId,
      episode: task.episode,
      disposition: "admitted",
      created_at_ms: task.createdAt,
    }),
  );
  appendSupervisedNotificationInTransaction(db, task, "accepted");
}
export function appendSupervisedNotificationInTransaction(
  db: DatabaseSync,
  task: SupervisedTask,
  kind: "accepted" | "endpoint",
) {
  const detail =
    kind === "accepted"
      ? `Task ${task.flowId} accepted for supervised continuation. Goal: ${task.goal?.objective ?? task.prompt}`
      : `Task ${task.flowId} — ${task.phase.replaceAll("_", " ")}: ${task.endpoint?.reason ?? "Stored episode requires attention"}${task.endpoint?.question ? `\n${task.endpoint.question}` : ""}`;
  const content =
    Buffer.byteLength(detail) <= 12 * 1024
      ? detail
      : `Task ${task.flowId} — ${task.phase.replaceAll("_", " ")}. The full result is retained in its task record; this notification omits oversized detail.`;
  appendNotification(db, task.flowId, task.episode, task.revision, task.updatedAt, kind, content);
}

/** Fault evidence remains opaque: notify from trusted projections, never decode
 * or expose the corrupt record to construct a user-facing endpoint. */
export function appendSupervisedFaultNotificationInTransaction(
  db: DatabaseSync,
  flowId: string,
  episode: number,
  revision: number,
  now: number,
) {
  appendNotification(
    db,
    flowId,
    episode,
    revision,
    now,
    "fault",
    `Task ${flowId} requires attention: its stored state could not be safely reconciled. Original records are preserved for repair; no new work will be dispatched.`,
  );
}

function appendNotification(
  db: DatabaseSync,
  flowId: string,
  episode: number,
  revision: number,
  now: number,
  kind: "accepted" | "endpoint" | "fault",
  content: string,
) {
  const sql = getNodeSqliteKysely<DB>(db);
  const source = executeSqliteQueryTakeFirstSync(
    db,
    sql.selectFrom("task_flow_sources").select("flow_id").where("flow_id", "=", flowId),
  );
  if (!source) {
    return;
  }
  executeSqliteQuerySync(
    db,
    sql
      .insertInto("task_flow_notifications")
      .values({
        notification_id: `supervised:${flowId}:${episode}:${kind}`,
        flow_id: flowId,
        episode,
        revision,
        content,
        state: "pending",
        attempts: 0,
        owner_id: null,
        lease_expires_at_ms: null,
        due_at_ms: now,
        created_at_ms: now,
        updated_at_ms: now,
        receipt_json: null,
      })
      .onConflict((conflict) => conflict.column("notification_id").doNothing()),
  );
}
export function getSupervisedTaskSource(flowId: string, options: Options = {}) {
  return readSupervisedWorkflow((db) => {
    if (!tableExists(db, "task_flow_sources")) {
      return undefined;
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_sources")
        .selectAll()
        .where("flow_id", "=", flowId),
    );
    if (!row) {
      return undefined;
    }
    const source = SupervisedTaskSourceSchema.parse(JSON.parse(row.record_json));
    if (
      source.agentId !== row.agent_id ||
      source.sessionKey !== row.session_key ||
      source.sessionId !== row.session_id
    ) {
      throw new Error("Task source projection changed");
    }
    return source;
  }, options);
}
