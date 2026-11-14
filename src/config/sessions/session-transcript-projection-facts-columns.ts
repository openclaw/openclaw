// Shared payload-derived projection columns. The full rebuild and the bounded
// active-path repoint must derive identical active-event facts, so both read the
// same expressions from this owner.
import { sql } from "kysely";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { transcriptDependencyFactsProjectableSql } from "./session-transcript-active-facts.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import {
  transcriptEventDependencyNavigationSql,
  transcriptPredicateSql,
} from "./transcript-payload.js";

export type SessionTranscriptProjectionFactsRow = {
  serialized_bytes?: number;
  dependency_navigation_json?: string | null;
  navigation_type?: string | null;
};

export function projectionFactsColumns(db: EngineConnection) {
  return [
    /* kysely-allow-raw: the projection retains the exact stored byte count and JSONL separator. */ sql<number>`${transcriptEventReadBytesSql()} + 1`.as(
      "serialized_bytes",
    ),
    // Eligibility is resolved by the existing JS branch owner. Capture the larger
    // candidate set here, during its existing payload read, then narrow it below.
    /* kysely-allow-raw: malformed and deep legacy rows retain their prior read-time projection. */ sql<
      string | null
    >`CASE WHEN ${transcriptDependencyFactsProjectableSql(db, "transcript_events")}
      THEN ${transcriptEventDependencyNavigationSql(db, sql.lit(0), "transcript_events")} ELSE NULL END`.as(
      "dependency_navigation_json",
    ),
    transcriptPredicateSql(db, "navigation_type").as("navigation_type"),
  ];
}

export function projectionRowFacts(
  row: SessionTranscriptProjectionFactsRow,
  contextEligible: 0 | 1,
) {
  return row.serialized_bytes === undefined || row.dependency_navigation_json == null
    ? undefined
    : {
        serializedBytes: row.serialized_bytes,
        dependencyNavigationJson:
          row.navigation_type === "message" && contextEligible !== 0
            ? "{}"
            : row.dependency_navigation_json,
      };
}
