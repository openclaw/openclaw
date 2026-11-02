import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { createSqliteSchemaEnsurer } from "../infra/sqlite-schema-ensure.js";
import { ensureStatePostgresFragment } from "../state/openclaw-state-db-engine.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import { getOpenClawStateFeatureSchemaSql } from "../state/openclaw-state-feature-schema.js";
export const EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE =
  "execution_owner_lifecycle_bindings" as const;
type ExecutionOwnerLifecycleKind = "cron";

type ExecutionOwnerLifecycleDatabase = Pick<
  OpenClawStateDatabase,
  "execution_owner_lifecycle_bindings"
>;

/** Only an enabled binding write allocates this existing optional table. */
const ensureNativeExecutionOwnerLifecycleBindingSchema = createSqliteSchemaEnsurer(
  () => getOpenClawStateFeatureSchemaSql(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE),
  { tables: [EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE] },
);

export function ensureExecutionOwnerLifecycleBindingSchema(db: EngineConnection): void {
  if (isPostgresSqlConnection(db)) {
    ensureStatePostgresFragment(db, EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE);
  } else {
    ensureNativeExecutionOwnerLifecycleBindingSchema(db);
  }
}

/** The first admitted execution owns this diagnostic link for the receipt's lifetime. */
export function bindExecutionOwnerLifecycleMetadata(params: {
  db: EngineConnection;
  ownerKind: ExecutionOwnerLifecycleKind;
  ownerId: string;
  binding: { contextId: string; executionId: string };
}): "bound" | "already-bound" | "mismatch" {
  const database = getNodeSqliteKysely<ExecutionOwnerLifecycleDatabase>(params.db);
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
  const current = executeSqliteQueryTakeFirstSync(
    params.db,
    database
      .selectFrom(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
      .select(["context_id", "execution_id"])
      .where("owner_kind", "=", params.ownerKind)
      .where("owner_id", "=", params.ownerId),
  );
  return current?.context_id === params.binding.contextId &&
    current.execution_id === params.binding.executionId
    ? "already-bound"
    : "mismatch";
}

/** Removes exact owner metadata without allocating the opt-in table. */
export function deleteExecutionOwnerLifecycleMetadata(params: {
  db: EngineConnection;
  ownerKind: ExecutionOwnerLifecycleKind;
  ownerIds: readonly string[];
  /** Connection-owned schema fact; deletion never allocates opt-in metadata. */
  executionOwnerLifecycleBindings: boolean;
}): void {
  if (params.ownerIds.length === 0 || !params.executionOwnerLifecycleBindings) {
    return;
  }
  executeSqliteQuerySync(
    params.db,
    getNodeSqliteKysely<ExecutionOwnerLifecycleDatabase>(params.db)
      .deleteFrom(EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE)
      .where("owner_kind", "=", params.ownerKind)
      .where("owner_id", "in", params.ownerIds),
  );
}
