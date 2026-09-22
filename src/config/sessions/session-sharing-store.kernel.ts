import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";

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
