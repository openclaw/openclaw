import { isDeepStrictEqual, toUSVString } from "node:util";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { publishSessionSharingMemberChange } from "./session-accessor.sqlite-entry-cache.js";
import { readSessionEntryInstanceId } from "./session-accessor.sqlite-entry-identity.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { getSessionMemberKysely, type SessionMember } from "./session-sharing-store.kernel.js";
import type { SessionEntry } from "./types.js";

export type SessionSharingExpectedEntry = Pick<
  SessionEntry,
  "sessionId" | "createdActor" | "visibility" | "incognito"
>;

// Membership is bound to a live session entry, never a transcript placeholder.
// Authorization is rechecked before these transactions, but a reset/recreate
// can replace the row under the same key in between; the optional expected id
// adds a caller snapshot check after the canonical node/entry check.
function assertAuthorizedSessionInstance(
  database: OpenClawAgentDatabase,
  sessionKey: string,
  expectedSessionId: string | undefined,
  expectedEntry?: SessionSharingExpectedEntry,
): string {
  const sessionId = readSessionEntryInstanceId(database, sessionKey);
  if (
    sessionId === undefined ||
    (expectedSessionId !== undefined && sessionId !== expectedSessionId)
  ) {
    throw new Error("session changed before sharing mutation");
  }
  if (expectedEntry) {
    const entry = readExactSessionEntryRow(database, sessionKey, "list")?.entry;
    if (
      !entry ||
      !isDeepStrictEqual(
        {
          sessionId: entry.sessionId,
          createdActor: entry.createdActor,
          visibility: entry.visibility,
          incognito: entry.incognito,
        },
        expectedEntry,
      )
    ) {
      throw new Error("session ownership changed before sharing mutation");
    }
  }
  return sessionId;
}

function publishCommittedSessionMembership(
  database: OpenClawAgentDatabase,
  agentId: string,
  sessionKey: string,
  sessionId: string,
  identityId: string,
  present: boolean,
): void {
  publishSessionSharingMemberChange(
    database,
    sessionKey,
    { kind: "member", sessionId, identityId: toUSVString(identityId), present },
    agentId,
  );
}

export function addSessionMember(
  scope: SessionAccessScope,
  params: {
    identityId: string;
    addedBy: string;
    addedAt?: number;
    expectedSessionId?: string;
    expectedEntry?: SessionSharingExpectedEntry;
  },
): { member: SessionMember; inserted: boolean } {
  const identityId = params.identityId.trim();
  const addedBy = params.addedBy.trim();
  if (!identityId || !addedBy) {
    throw new Error("session member identity and actor are required");
  }
  const options = toDatabaseOptions(resolveSqliteScope(scope));
  const { agentId, sessionKey } = resolveSqliteScope(scope);
  const addedAt = params.addedAt ?? Date.now();
  const inserted = runOpenClawAgentWriteTransaction((database) => {
    const sessionId = assertAuthorizedSessionInstance(
      database,
      sessionKey,
      params.expectedSessionId,
      params.expectedEntry,
    );
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
      publishCommittedSessionMembership(database, agentId, sessionKey, sessionId, identityId, true);
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
  expectedEntry?: SessionSharingExpectedEntry,
): SessionMember | null {
  const normalizedIdentityId = identityId.trim();
  if (!normalizedIdentityId) {
    return null;
  }
  const options = toDatabaseOptions(resolveSqliteScope(scope));
  const { agentId, sessionKey } = resolveSqliteScope(scope);
  return runOpenClawAgentWriteTransaction((database) => {
    const sessionId = assertAuthorizedSessionInstance(
      database,
      sessionKey,
      expectedSessionId,
      expectedEntry,
    );
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
    publishCommittedSessionMembership(
      database,
      agentId,
      sessionKey,
      sessionId,
      normalizedIdentityId,
      false,
    );
    return { identityId: row.identity_id, addedBy: row.added_by, addedAt: row.added_at };
  }, options);
}
