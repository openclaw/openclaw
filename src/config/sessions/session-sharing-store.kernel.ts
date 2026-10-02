import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

export type SessionMember = {
  identityId: string;
  addedBy: string;
  addedAt: number;
};

export function listSessionMembersInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
): SessionMember[] {
  return executeSqliteQuerySync(
    database.db,
    getSessionMemberKysely(database)
      .selectFrom("session_members")
      .select(["identity_id", "added_by", "added_at"])
      .where("session_key", "=", sessionKey)
      .orderBy("identity_id"),
  ).rows.map((row) => ({
    identityId: row.identity_id,
    addedBy: row.added_by,
    addedAt: row.added_at,
  }));
}

type SessionMemberDatabase = Pick<OpenClawAgentKyselyDatabase, "session_members">;

export function getSessionMemberKysely(database: Pick<OpenClawAgentDatabase, "db">) {
  return getNodeSqliteKysely<SessionMemberDatabase>(database.db);
}

export function hasSessionMemberInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  normalizedIdentityId: string,
): boolean {
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionMemberKysely(database)
        .selectFrom("session_members")
        .select("identity_id")
        .where("session_key", "=", sessionKey)
        .where("identity_id", "=", normalizedIdentityId),
    ),
  );
}
