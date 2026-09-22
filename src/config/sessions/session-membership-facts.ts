import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { isInternalSessionEffectsKey } from "./internal-session-key.js";
import { validateDeliveryCanonicalSessionEntry } from "./session-accessor.sqlite-entry-read.js";
import { participantRecordsBySessionKey } from "./session-accessor.sqlite-participant-projection.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson, selectSessionEntryRows } from "./session-accessor.sqlite-status.js";
import { assertCanonicalSqliteSessionKeysCurrent } from "./session-canonical-key.js";
import type {
  SessionMembershipFact,
  SessionMembershipFacts,
} from "./session-membership-facts.types.js";

/** The read-only worker projects a store once, then only keys named by committed publications. */
export function readSessionMembershipFactsInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  sessionKeys?: readonly string[],
): SessionMembershipFacts {
  const { identity, birthtime } = readOpenClawAgentDatabaseIdentity(database);
  if (typeof identity !== "string") {
    throw new Error("Durable session membership requires a physical database");
  }
  if (sessionKeys?.length === 0) {
    return { kind: "session-membership-facts", identity, birthtime, facts: [] };
  }
  return withSqlitePostCommitPublications(database.db, () =>
    runSqliteDeferredTransactionSync(database.db, () => {
      assertCanonicalSqliteSessionKeysCurrent(database);
      let entries = selectSessionEntryRows(database, "list")
        .select("updated_at")
        .orderBy("session_key");
      let members = getSessionKysely(database.db)
        .selectFrom("session_members")
        .select(["session_key", "identity_id"])
        .orderBy("session_key")
        .orderBy("identity_id");
      if (sessionKeys) {
        entries = entries.where("session_key", "in", sqliteStringSet(sessionKeys));
        members = members.where("session_key", "in", sqliteStringSet(sessionKeys));
      }
      const facts = new Map<string, SessionMembershipFact>();
      const readableKeys: string[] = [];
      for (const row of executeSqliteQuerySync(database.db, entries).rows) {
        const entry = parseSessionEntryJson(row, "list");
        if (!entry) {
          continue;
        }
        const internal = isInternalSessionEffectsKey(row.session_key);
        if (!internal) {
          validateDeliveryCanonicalSessionEntry(row.session_key, entry);
        }
        readableKeys.push(row.session_key);
        facts.set(row.session_key, [
          row.session_key,
          internal ? null : (normalizeOptionalString(entry.category) ?? null),
          [],
          {},
          entry.sessionId,
        ]);
      }
      const memberships = new Map<string, string[]>();
      for (const row of executeSqliteQuerySync(database.db, members).rows) {
        const values = memberships.get(row.session_key) ?? [];
        values.push(row.identity_id);
        memberships.set(row.session_key, values);
      }
      for (const [sessionKey, values] of memberships) {
        const current = facts.get(sessionKey);
        facts.set(sessionKey, [
          sessionKey,
          current?.[1] ?? null,
          values,
          current?.[3] ?? {},
          current?.[4] ?? null,
        ]);
      }
      for (const [sessionKey, records] of participantRecordsBySessionKey(
        database.db,
        readableKeys,
      )) {
        const current = facts.get(sessionKey);
        facts.set(sessionKey, [
          sessionKey,
          current?.[1] ?? null,
          current?.[2] ?? [],
          {
            participants: records.map(({ identity: participantIdentity }) => ({
              identity: participantIdentity,
            })),
            participantCount: records.length,
          },
          current?.[4] ?? null,
        ]);
      }
      return {
        kind: "session-membership-facts" as const,
        identity,
        birthtime,
        facts: [...facts.values()],
      };
    }),
  );
}
