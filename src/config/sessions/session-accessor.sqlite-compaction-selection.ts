import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { scanSessionTranscriptNavigationTree } from "./session-accessor.sqlite-branch-summaries.js";
import { selectActiveTranscriptEventRows } from "./session-accessor.sqlite-projection-read.js";
import { summarizeSelectedCompactions } from "./session-message-cut-plan.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import { transcriptPredicateSql } from "./transcript-payload.js";
import { selectSessionTranscriptTreePathNodes } from "./transcript-tree.js";

type Database = Pick<OpenClawAgentDatabase, "db">;

export function selectActiveCompactionMarkers(database: Database, sessionId: string) {
  const type = transcriptPredicateSql(database.db, "navigation_last_type", "event");
  return selectActiveTranscriptEventRows(database)
    .select(["active.event_seq", type.as("type")])
    .where("active.session_id", "=", sessionId)
    .where("active.message_position", "is", null)
    .where(type, "in", ["reset", "compaction"])
    .orderBy("active.active_position", "asc");
}

export function countRetainedCutCompactions(database: Database, sessionId: string): number {
  if (sessionTranscriptIndexNeedsReconcile(database.db, sessionId)) {
    const { tree } = scanSessionTranscriptNavigationTree(database, sessionId);
    return summarizeSelectedCompactions(
      selectSessionTranscriptTreePathNodes(tree, tree.leafId),
      ({ entry }) => entry?.type,
    ).count;
  }
  return summarizeSelectedCompactions(
    iterateSqliteQuerySync(database.db, selectActiveCompactionMarkers(database, sessionId)),
    (row) => row.type,
  ).count;
}
