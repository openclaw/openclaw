import { z } from "zod";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { supervisedCommandScopeName } from "./supervised-command-resources.js";
import {
  readSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";

/** Read side of the command-resource binding, owned below custody: launch
 * capacity accounting must consult an execution's binding without depending on
 * the custody write path that plans, seals and closes it. Custody re-exports
 * the reader so callers keep one canonical entry point. */

export const supervisedCommandIdentitySchema = z.strictObject({
  executionId: z.uuid(),
  scopeName: z.string().max(128),
  invocationId: z.string().regex(/^[a-f0-9]{32}$/),
  controlGroup: z.string().min(1).max(4096),
  bootId: z.uuid(),
  hostId: z.string().regex(/^[a-f0-9]{64}$/),
  custodian: z.strictObject({
    pid: z.number().int().positive(),
    startTime: z.number().int().nonnegative(),
  }),
  cgroupDevice: z.string().regex(/^\d+$/),
  cgroupInode: z.string().regex(/^\d+$/),
  limits: z.strictObject({
    memoryBytes: z.number().int().positive(),
    tasks: z.number().int().positive(),
  }),
});

export const supervisedCommandPrebindingSchema = z.strictObject({
  kind: z.literal("prebinding"),
  executionId: z.uuid(),
  hostId: z.string().regex(/^[a-f0-9]{64}$/),
  bootId: z.uuid(),
  launcher: z.strictObject({
    pid: z.number().int().positive(),
    startTime: z.number().int().nonnegative(),
  }),
  transport: z.enum(["not_started", "started", "extinct"]),
});

export function decodeSupervisedCommandBinding(encoded: string | null) {
  if (encoded === null) {
    return { identity: null, prebinding: null };
  }
  const value: unknown = JSON.parse(encoded);
  const plan = supervisedCommandPrebindingSchema.safeParse(value);
  return plan.success
    ? { identity: null, prebinding: plan.data }
    : { identity: supervisedCommandIdentitySchema.parse(value), prebinding: null };
}

export function getSupervisedCommandResources(executionId: string, options: Options = {}) {
  return readSupervisedWorkflow((db) => {
    if (!tableExists(db, "task_flow_command_resources")) {
      return undefined;
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_command_resources")
        .selectAll()
        .where("execution_id", "=", executionId),
    );
    if (!row) {
      return undefined;
    }
    const { identity, prebinding } = decodeSupervisedCommandBinding(row.identity_json);
    if (
      (prebinding && (prebinding.executionId !== executionId || row.state === "bound")) ||
      row.scope_name !== supervisedCommandScopeName(executionId) ||
      (identity && (identity.executionId !== executionId || identity.scopeName !== row.scope_name))
    ) {
      throw new Error("Corrupt command resource binding");
    }
    return { ...row, identity, prebinding };
  }, options);
}
