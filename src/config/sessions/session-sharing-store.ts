import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryInstanceId } from "./session-accessor.sqlite-entry-identity.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  getSessionMemberKysely,
  hasSessionMemberInDatabase,
  listSessionMembersInDatabase,
  type SessionMember,
} from "./session-sharing-store.kernel.js";

function resolveDatabaseOptions(scope: SessionAccessScope): OpenClawAgentDatabaseOptions {
  return toDatabaseOptions(resolveSqliteScope(scope));
}

function readSessionMembers<T>(
  scope: SessionAccessScope,
  fallback: T,
  operation: (database: Pick<OpenClawAgentDatabase, "db">) => T,
): T {
  const result = withOpenClawAgentDatabaseReadOnly(operation, resolveDatabaseOptions(scope));
  return result.found ? result.value : fallback;
}

export function listSessionMembers(scope: SessionAccessScope): SessionMember[] {
  return readSessionMembers(scope, [], (database) =>
    listSessionMembersInDatabase(database, resolveSqliteScope(scope).sessionKey),
  );
}

export function isSessionMember(scope: SessionAccessScope, identityId: string): boolean {
  const normalizedIdentityId = identityId.trim();
  if (!normalizedIdentityId) {
    return false;
  }
  return readSessionMembers(scope, false, (database) =>
    hasSessionMemberInDatabase(
      database,
      resolveSqliteScope(scope).sessionKey,
      normalizedIdentityId,
    ),
  );
}

// Membership is bound to a live session entry, never a transcript placeholder.
// Authorization is rechecked before these transactions, but a reset/recreate
// can replace the row under the same key in between; the optional expected id
// adds a caller snapshot check after the canonical node/entry check.
function assertAuthorizedSessionInstance(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  expectedSessionId: string | undefined,
): void {
  const sessionId = readSessionEntryInstanceId(database, sessionKey);
  if (
    sessionId === undefined ||
    (expectedSessionId !== undefined && sessionId !== expectedSessionId)
  ) {
    throw new Error("session changed before sharing mutation");
  }
}

export function addSessionMember(
  scope: SessionAccessScope,
  params: { identityId: string; addedBy: string; addedAt?: number; expectedSessionId?: string },
): { member: SessionMember; inserted: boolean } {
  const identityId = params.identityId.trim();
  const addedBy = params.addedBy.trim();
  if (!identityId || !addedBy) {
    throw new Error("session member identity and actor are required");
  }
  const options = resolveDatabaseOptions(scope);
  const { agentId, sessionKey } = resolveSqliteScope(scope);
  const addedAt = params.addedAt ?? Date.now();
  const inserted = runOpenClawAgentWriteTransaction((database) => {
    assertAuthorizedSessionInstance(database, sessionKey, params.expectedSessionId);
    const db = getSessionMemberKysely(database);
    const result = executeSqliteQuerySync(
      database.db,
      db
        .insertInto("session_members")
        .values({
          session_key: sessionKey,
          identity_id: identityId,
          added_by: addedBy,
          added_at: addedAt,
        })
        .onConflict((conflict) => conflict.columns(["session_key", "identity_id"]).doNothing()),
    );
    const changed = (result.numAffectedRows ?? 0n) > 0n;
    if (changed) {
      sessionChanges.emit({ agentId, storePath: database.path, sessionKey }, database.db);
    }
    return changed;
  }, options);
  return { member: { identityId, addedBy, addedAt }, inserted };
}

export function removeSessionMember(
  scope: SessionAccessScope,
  identityId: string,
  expected?: Pick<SessionMember, "addedBy" | "addedAt">,
  expectedSessionId?: string,
): SessionMember | null {
  const normalizedIdentityId = identityId.trim();
  if (!normalizedIdentityId) {
    return null;
  }
  const options = resolveDatabaseOptions(scope);
  const { agentId, sessionKey } = resolveSqliteScope(scope);
  return runOpenClawAgentWriteTransaction((database) => {
    assertAuthorizedSessionInstance(database, sessionKey, expectedSessionId);
    const db = getSessionMemberKysely(database);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("session_members")
        .select(["identity_id", "added_by", "added_at"])
        .where("session_key", "=", sessionKey)
        .where("identity_id", "=", normalizedIdentityId),
    );
    if (
      !row ||
      (expected && (row.added_by !== expected.addedBy || row.added_at !== expected.addedAt))
    ) {
      return null;
    }
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("session_members")
        .where("session_key", "=", sessionKey)
        .where("identity_id", "=", normalizedIdentityId),
    );
    sessionChanges.emit({ agentId, storePath: database.path, sessionKey }, database.db);
    return { identityId: row.identity_id, addedBy: row.added_by, addedAt: row.added_at };
  }, options);
}
