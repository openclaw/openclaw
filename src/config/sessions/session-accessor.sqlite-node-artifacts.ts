import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

export function clearSessionMembersForKey(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): void {
  if (!readSessionNodeArtifactTables(database).has("session_members")) {
    return;
  }
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_members").where("session_key", "=", sessionKey),
  );
}

export function rehomeLegacySessionNodeArtifacts(
  database: OpenClawAgentDatabase,
  legacyKey: string,
  canonicalKey: string,
  options: { rehomeMembers?: boolean },
): void {
  const db = getSessionKysely(database.db);
  const presentTables = readSessionNodeArtifactTables(database);
  if (presentTables.has("board_tabs") && presentTables.has("board_widgets")) {
    const tabs = executeSqliteQuerySync(
      database.db,
      db.selectFrom("board_tabs").selectAll().where("session_key", "=", legacyKey),
    ).rows;
    for (const tab of tabs) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("board_tabs")
          .values({ ...tab, session_key: canonicalKey })
          .onConflict((conflict) => conflict.columns(["session_key", "tab_id"]).doNothing()),
      );
    }
    const widgets = executeSqliteQuerySync(
      database.db,
      db.selectFrom("board_widgets").selectAll().where("session_key", "=", legacyKey),
    ).rows;
    for (const widget of widgets) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("board_widgets")
          .values({ ...widget, session_key: canonicalKey })
          .onConflict((conflict) => conflict.columns(["session_key", "name"]).doNothing()),
      );
    }
  }
  if (presentTables.has("heartbeat_outcomes")) {
    const heartbeat = executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("heartbeat_outcomes").selectAll().where("session_key", "=", legacyKey),
    );
    if (heartbeat) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("heartbeat_outcomes")
          .values({ ...heartbeat, session_key: canonicalKey })
          .onConflict((conflict) => conflict.column("session_key").doNothing()),
      );
    }
  }
  if (options.rehomeMembers !== false && presentTables.has("session_members")) {
    const members = executeSqliteQuerySync(
      database.db,
      db.selectFrom("session_members").selectAll().where("session_key", "=", legacyKey),
    ).rows;
    for (const member of members) {
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("session_members")
          .values({ ...member, session_key: canonicalKey })
          .onConflict((conflict) => conflict.columns(["session_key", "identity_id"]).doNothing()),
      );
    }
  }
}

export function deleteSessionNodeArtifacts(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): void {
  const db = getSessionKysely(database.db);
  const presentTables = readSessionNodeArtifactTables(database);
  if (presentTables.has("board_tabs") && presentTables.has("board_widgets")) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("board_widgets").where("session_key", "=", sessionKey),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("board_tabs").where("session_key", "=", sessionKey),
    );
  }
  if (presentTables.has("heartbeat_outcomes")) {
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("heartbeat_outcomes").where("session_key", "=", sessionKey),
    );
  }
  clearSessionMembersForKey(database, sessionKey);
}

function readSessionNodeArtifactTables(database: OpenClawAgentDatabase): Set<string> {
  const db = getSessionKysely(database.db);
  return new Set(
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "in", [
          "board_tabs",
          "board_widgets",
          "heartbeat_outcomes",
          "session_members",
        ]),
    ).rows.flatMap((row) => (row.name ? [row.name] : [])),
  );
}
