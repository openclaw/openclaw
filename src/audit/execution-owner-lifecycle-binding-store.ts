import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
export const EXECUTION_OWNER_LIFECYCLE_BINDING_TABLE =
  "execution_owner_lifecycle_bindings" as const;
type ExecutionOwnerLifecycleKind = "cron";

type ExecutionOwnerLifecycleDatabase = Pick<
  OpenClawStateDatabase,
  "execution_owner_lifecycle_bindings"
>;

/** Removes exact owner metadata without allocating the opt-in table. */
export function deleteExecutionOwnerLifecycleMetadata(params: {
  db: DatabaseSync;
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
