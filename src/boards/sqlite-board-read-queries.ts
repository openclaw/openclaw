import type { DatabaseSync } from "node:sqlite";
import { getNodeSqliteKysely, prepareSqliteQuerySync } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  BOARD_WIDGET_SNAPSHOT_COLUMNS,
  type SelectedBoardTabRow,
  type SelectedBoardWidgetSnapshotRow,
} from "./sqlite-board-codec.js";

function createBoardReadQueries(database: DatabaseSync) {
  const db =
    getNodeSqliteKysely<Pick<DB, "board_tabs" | "board_widgets" | "session_nodes">>(database);
  return {
    session: prepareSqliteQuerySync<string, { entry_json: string }>(database, (parameter) =>
      db
        .selectFrom("session_nodes")
        .select("entry_json")
        .where(
          "session_key",
          "=",
          parameter((key) => key),
        )
        .limit(1),
    ),
    tabs: prepareSqliteQuerySync<string, SelectedBoardTabRow>(database, (parameter) =>
      db
        .selectFrom("board_tabs")
        .selectAll()
        .where(
          "session_key",
          "=",
          parameter((key) => key),
        )
        .orderBy("position", "asc")
        .orderBy("tab_id", "asc"),
    ),
    widgets: prepareSqliteQuerySync<string, SelectedBoardWidgetSnapshotRow>(database, (parameter) =>
      db
        .selectFrom("board_widgets")
        .select(BOARD_WIDGET_SNAPSHOT_COLUMNS)
        .where(
          "session_key",
          "=",
          parameter((key) => key),
        )
        .orderBy("tab_id", "asc")
        .orderBy("position", "asc")
        .orderBy("name", "asc"),
    ),
  };
}

const boardReadQueries = new WeakMap<DatabaseSync, ReturnType<typeof createBoardReadQueries>>();

export function getBoardReadQueries(database: DatabaseSync) {
  let queries = boardReadQueries.get(database);
  if (!queries) {
    queries = createBoardReadQueries(database);
    boardReadQueries.set(database, queries);
  }
  return queries;
}
