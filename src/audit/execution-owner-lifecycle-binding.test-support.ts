import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE } from "./execution-owner-lifecycle-binding-store.js";

type ExecutionOwnerLifecycleKind = "cron";
type ExecutionOwnerLifecycleDatabase = Pick<
  OpenClawStateDatabase,
  "execution_owner_lifecycle_bindings"
>;

const SCHEMA_START = `CREATE TABLE IF NOT EXISTS ${EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE} (`;
const SCHEMA_END = ") STRICT;";

/** Creates the shipped optional table for legacy reader fixtures. */
export function ensureExecutionOwnerLifecycleBindingSchema(db: DatabaseSync): void {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(SCHEMA_START);
  const end = start < 0 ? -1 : OPENCLAW_STATE_SCHEMA_SQL.indexOf(SCHEMA_END, start);
  if (start < 0 || end < start) {
    throw new Error("OpenClaw execution owner lifecycle binding schema marker is missing.");
  }
  db.exec(OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + SCHEMA_END.length));
}

function classifyRetainedBinding(
  current: { context_id: string; execution_id: string },
  binding: { contextId: string; executionId: string },
): "already-bound" | "mismatch" {
  return current.context_id === binding.contextId && current.execution_id === binding.executionId
    ? "already-bound"
    : "mismatch";
}

/** Seeds retained lifecycle metadata for reader compatibility tests. */
export function bindExecutionOwnerLifecycleMetadata(params: {
  db: DatabaseSync;
  ownerKind: ExecutionOwnerLifecycleKind;
  ownerId: string;
  binding: { contextId: string; executionId: string };
}): "bound" | "already-bound" | "mismatch" {
  const database = getNodeSqliteKysely<ExecutionOwnerLifecycleDatabase>(params.db);
  const current = executeSqliteQueryTakeFirstSync(
    params.db,
    database
      .selectFrom(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
      .select(["context_id", "execution_id"])
      .where("owner_kind", "=", params.ownerKind)
      .where("owner_id", "=", params.ownerId),
  );
  if (current) {
    return classifyRetainedBinding(current, params.binding);
  }
  const inserted = executeSqliteQuerySync(
    params.db,
    database
      .insertInto(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
      .values({
        owner_kind: params.ownerKind,
        owner_id: params.ownerId,
        context_id: params.binding.contextId,
        execution_id: params.binding.executionId,
      })
      .onConflict((conflict) => conflict.columns(["owner_kind", "owner_id"]).doNothing()),
  );
  if (Number(inserted.numAffectedRows ?? 0n) === 1) {
    return "bound";
  }
  const raced = executeSqliteQueryTakeFirstSync(
    params.db,
    database
      .selectFrom(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
      .select(["context_id", "execution_id"])
      .where("owner_kind", "=", params.ownerKind)
      .where("owner_id", "=", params.ownerId),
  );
  return raced ? classifyRetainedBinding(raced, params.binding) : "mismatch";
}
