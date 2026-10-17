import { sql, type RawBuilder } from "kysely";
import { assertSqliteJsonlReadBudget } from "../../infra/sqlite-jsonl-budget.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import { transcriptEventUtf8BytesSql, type TranscriptPayloadAlias } from "./transcript-payload.js";

/** Preserve native identity accounting where a legacy row has no exact UTF-8 size. */
export function transcriptEventReadBytesSql(
  alias: TranscriptPayloadAlias = "transcript_events",
): RawBuilder<number> {
  const identity =
    /* kysely-allow-raw: closed transcript aliases select the canonical identity column. */ sql.ref(
      `${alias}.event_json`,
    );
  return /* kysely-allow-raw: recorded uncompressed bytes or native identity column metadata preserve existing byte budgets. */ sql<number>`coalesce(${transcriptEventUtf8BytesSql(alias)}, octet_length(${identity}))`;
}

export function assertTranscriptEventReadBudget(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  options: {
    beforeEventSeq?: number;
    maxEventBytes?: number;
  },
): void {
  const { beforeEventSeq, maxEventBytes } = options;
  if (maxEventBytes !== undefined && Number.isFinite(maxEventBytes) && maxEventBytes >= 0) {
    assertSqliteJsonlReadBudget(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select(["event_json", "event_utf8_bytes"])
        .where("session_id", "=", sessionId)
        .$if(beforeEventSeq !== undefined, (query) => query.where("seq", "<", beforeEventSeq!))
        .as("events"),
      Math.floor(maxEventBytes),
      "Trajectory transcript store",
      { hasExactUtf8Bytes: true },
    );
  }
}
