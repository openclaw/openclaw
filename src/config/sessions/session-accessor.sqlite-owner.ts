import { isDeepStrictEqual } from "node:util";
import { jsonScannedValue } from "../../infra/database-engine/json-values.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withSqliteDatabaseWriteScope } from "../../infra/sqlite-database-admission.js";
import { scanJsonObjectFields } from "../../state/json-predicate-fields.js";
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
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionOwnerAssignment } from "./session-entry-provenance.js";
import type { SessionEntryWritePostimages } from "./session-entry-write-postimage.js";
import type {
  SessionMetadataExpectedEntry,
  SessionOwnerAssignParams,
} from "./session-sharing-store.types.js";

function metadataAuthorityEntry(entry: SessionMetadataExpectedEntry): SessionMetadataExpectedEntry {
  return {
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    createdActor: entry.createdActor,
    visibility: entry.visibility,
    incognito: entry.incognito,
  };
}

/** Compare authoritative transaction-held fields without treating presentation updates as revocation. */
export function sessionMetadataExpectedEntryMatches(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  expectedEntry: SessionMetadataExpectedEntry,
): boolean {
  const entry = readExactSessionEntryRow(database, sessionKey, "list")?.entry;
  return (
    entry !== undefined &&
    isDeepStrictEqual(metadataAuthorityEntry(entry), metadataAuthorityEntry(expectedEntry))
  );
}

export function replaceSessionOwnerInTransaction(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  owner: SessionOwnerAssignment | undefined,
  postimages?: SessionEntryWritePostimages,
  expectedSessionId?: string,
): boolean {
  if (!hasSqliteSessionOwnerColumns(database.db)) {
    if (!owner?.actor.id) {
      return false;
    }
    for (const { columnName, dataType, tableName } of SESSION_OWNER_COLUMN_DEFINITIONS) {
      ensureColumn(database.db, tableName, `${columnName} ${dataType}`);
    }
  }
  let updated: { current_session_id: string; metadata_json: string } | undefined;
  const writeGeneration = trackSessionEntryCacheWrite(database, () =>
    withSqliteDatabaseWriteScope(database.db, [sessionKey], () => {
      const query = getSessionKysely(database.db)
        .updateTable("session_nodes")
        .set({
          owner_actor_type: owner?.actor.type ?? null,
          owner_actor_id: owner?.actor.id ?? null,
          owner_assigned_by_type: owner?.assignedBy?.type ?? null,
          owner_assigned_by_id: owner?.assignedBy?.id ?? null,
          owner_assigned_at: owner?.assignedAt ?? null,
        })
        .where("session_key", "=", sessionKey)
        .returning(["current_session_id", "entry_json as metadata_json"]);
      updated = executeSqliteQuerySync(
        database.db,
        expectedSessionId === undefined
          ? query
          : query.where("current_session_id", "=", expectedSessionId),
      ).rows[0];
    }),
  );
  if (!updated) {
    return false;
  }
  const fields = scanJsonObjectFields(updated.metadata_json, ["lifecycleRevision"]);
  const lifecycleRevision = jsonScannedValue(fields.first.get("lifecycleRevision"));
  if (
    !fields.valid ||
    fields.maximumDepth > 1000 ||
    (lifecycleRevision !== null && typeof lifecycleRevision !== "string")
  ) {
    throw new Error("Session lifecycle revision metadata requires repair");
  }
  const postimage = postimages?.get(sessionKey);
  if (postimage) {
    postimage.entry = { ...postimage.entry, owner };
    postimage.changed = true;
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
        lifecycleRevision,
        owner,
      },
    },
    writeGeneration,
  );
  return true;
}

export function assignSessionOwner(
  scope: SessionAccessScope,
  params: SessionOwnerAssignParams & { assertCurrent?: () => void },
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
      if (
        params.expectedSessionId !== undefined &&
        params.expectedEntry &&
        params.expectedEntry.sessionId !== params.expectedSessionId
      ) {
        throw new Error("session changed before owner assignment");
      }
      if (
        params.expectedEntry &&
        !sessionMetadataExpectedEntryMatches(database, resolved.sessionKey, params.expectedEntry)
      ) {
        throw new Error("session ownership changed before owner assignment");
      }
      const replaced = replaceSessionOwnerInTransaction(
        database,
        resolved.sessionKey,
        owner,
        undefined,
        params.expectedSessionId,
      );
      if (!replaced && params.expectedSessionId !== undefined) {
        throw new Error("session changed before owner assignment");
      }
      return replaced;
    },
    options,
    { operationLabel: "sessions.assign-owner" },
  );
  return updated ? owner : null;
}
