import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { SESSION_OWNER_COLUMN_DEFINITIONS } from "../../state/openclaw-agent-db-additive-columns.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  publishSessionEntryCacheInvalidation,
  trackSessionEntryCacheWrite,
} from "./session-accessor.sqlite-entry-cache.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionActor, SessionOwnerAssignment } from "./session-entry-provenance.js";

export function replaceSessionOwnerInTransaction(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  owner: SessionOwnerAssignment | undefined,
): boolean {
  if (!hasSqliteSessionOwnerColumns(database.db)) {
    if (!owner?.actor.id) {
      return false;
    }
    for (const { columnName, dataType, tableName } of SESSION_OWNER_COLUMN_DEFINITIONS) {
      ensureColumn(database.db, tableName, `${columnName} ${dataType}`);
    }
  }
  let updated: { current_session_id: string; lifecycle_revision: string | null } | undefined;
  const writeGeneration = trackSessionEntryCacheWrite(database, () => {
    updated = executeSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .updateTable("session_nodes")
        .set({
          owner_actor_type: owner?.actor.type ?? null,
          owner_actor_id: owner?.actor.id ?? null,
          owner_assigned_by_type: owner?.assignedBy?.type ?? null,
          owner_assigned_by_id: owner?.assignedBy?.id ?? null,
          owner_assigned_at: owner?.assignedAt ?? null,
        })
        .where("session_key", "=", sessionKey)
        .returning((eb) => [
          "current_session_id",
          eb
            .fn<string | null>("json_extract", [
              eb.ref("entry_json"),
              eb.val("$.lifecycleRevision"),
            ])
            .as("lifecycle_revision"),
        ]),
    ).rows[0];
  });
  if (!updated) {
    return false;
  }
  publishSessionEntryCacheInvalidation(
    database,
    // Publish the committed assignment, without revoking unrelated creator/admin
    // access or rereading session JSON on the Gateway thread.
    {
      sessionKey,
      facts: {
        kind: "owner",
        sessionId: updated.current_session_id,
        lifecycleRevision: updated.lifecycle_revision,
        owner,
      },
    },
    writeGeneration,
  );
  return true;
}

export function assignSessionOwner(
  scope: SessionAccessScope,
  params: {
    owner: SessionActor & { id: string };
    assignedBy: SessionActor & { id: string };
    assignedAt?: number;
    assertCurrent?: () => void;
  },
): SessionOwnerAssignment | null {
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  const owner: SessionOwnerAssignment = {
    actor: params.owner,
    assignedBy: params.assignedBy,
    assignedAt: params.assignedAt ?? Date.now(),
  };
  const updated = runOpenClawAgentWriteTransaction(
    (database) => {
      params.assertCurrent?.();
      return replaceSessionOwnerInTransaction(database, resolved.sessionKey, owner);
    },
    options,
    { operationLabel: "sessions.assign-owner" },
  );
  return updated ? owner : null;
}
