import { isDeepStrictEqual, toUSVString } from "node:util";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { withSqliteDatabaseWriteScope } from "../../infra/sqlite-database-admission.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { publishSessionSharingMemberChange } from "./session-accessor.sqlite-entry-cache.js";
import { readSessionEntryInstanceId } from "./session-accessor.sqlite-entry-identity.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionMember } from "./session-membership-facts.types.js";
import { getSessionMemberKysely } from "./session-sharing-store.kernel.js";
import type {
  SessionMemberAdd,
  SessionSharingExpectedEntry,
} from "./session-sharing-store.types.js";
export type { SessionSharingExpectedEntry } from "./session-sharing-store.types.js";

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
  params: SessionMemberAdd,
): { member: SessionMember; inserted: boolean } {
  const identityId = params.identityId.trim();
  const addedBy = params.addedBy.trim();
  if (!identityId || !addedBy) {
    throw new Error("session member identity and actor are required");
  }
  const resolved = resolveSqliteScope(scope);
  const { agentId, sessionKey } = resolved;
  const addedAt = params.addedAt ?? Date.now();
  const inserted = runOpenClawAgentWriteTransaction(
    (database) => {
      const sessionId = assertAuthorizedSessionInstance(
        database,
        sessionKey,
        params.expectedSessionId,
        params.expectedEntry,
      );
      const db = getSessionMemberKysely(database);
      const result = withSqliteDatabaseWriteScope(database.db, [sessionKey], () =>
        executeSqliteQuerySync(
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
        ),
      );
      const changed = (result.numAffectedRows ?? 0n) > 0n;
      if (changed) {
        publishCommittedSessionMembership(
          database,
          agentId,
          sessionKey,
          sessionId,
          identityId,
          true,
        );
      }
      return changed;
    },
    toDatabaseOptions(resolved),
    { operationLabel: "session.sharing.add-member" },
  );
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
  const resolved = resolveSqliteScope(scope);
  const { agentId, sessionKey } = resolved;
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const sessionId = assertAuthorizedSessionInstance(
        database,
        sessionKey,
        expectedSessionId,
        expectedEntry,
      );
      const db = getSessionMemberKysely(database);
      // SQLite replaces lone surrogates at binding; the expected grant uses decoded row values.
      if (expected && expected.addedBy !== toUSVString(expected.addedBy)) {
        return null;
      }
      let removal = db
        .deleteFrom("session_members")
        .where("session_key", "=", sessionKey)
        .where("identity_id", "=", normalizedIdentityId);
      if (expected) {
        removal = removal
          .where("added_by", "=", expected.addedBy)
          .where("added_at", "=", expected.addedAt);
      }
      const row = withSqliteDatabaseWriteScope(database.db, [sessionKey], () =>
        executeSqliteQueryTakeFirstSync(
          database.db,
          removal.returning(["identity_id", "added_by", "added_at"]),
        ),
      );
      if (!row) {
        return null;
      }
      publishCommittedSessionMembership(
        database,
        agentId,
        sessionKey,
        sessionId,
        normalizedIdentityId,
        false,
      );
      return { identityId: row.identity_id, addedBy: row.added_by, addedAt: row.added_at };
    },
    toDatabaseOptions(resolved),
    { operationLabel: "session.sharing.remove-member" },
  );
}
