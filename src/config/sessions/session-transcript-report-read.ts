import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { jsonExtractText } from "../../infra/database-engine/json-values.js";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  assertCurrentSessionTranscriptHeader,
  findSessionTranscriptHeader,
} from "./session-entry-codec.js";
import {
  decodeSessionTranscriptReportFacts,
  projectSessionTranscriptReportFacts,
  type SessionTranscriptReportFacts,
} from "./session-transcript-report-facts.js";
import { TranscriptReportNavigation } from "./session-transcript-report-policy.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

export function readTranscriptReportNavigation(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  beforeEventSeq?: number,
) {
  const rows = iterateSqliteQuerySync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select((eb) => [
        "seq",
        "event_json",
        jsonExtractText(database.db, eb.ref("navigation_json"), "report").as("report_json"),
      ])
      .where("session_id", "=", sessionId)
      .$if(beforeEventSeq !== undefined, (query) => query.where("seq", "<", beforeEventSeq!))
      .orderBy("seq", "asc"),
  );
  function compressedFacts(reportJson: string | null): SessionTranscriptReportFacts {
    const facts =
      reportJson === null ? undefined : decodeSessionTranscriptReportFacts(JSON.parse(reportJson));
    if (!facts) {
      throw new Error("Invalid compressed transcript report facts");
    }
    return facts;
  }
  let hasRows = false;
  let header: ReturnType<typeof findSessionTranscriptHeader>;
  const navigation = new TranscriptReportNavigation(
    (function* () {
      for (const row of rows) {
        hasRows = true;
        if (row.event_json === null) {
          yield { seq: row.seq, facts: compressedFacts(row.report_json) };
          continue;
        }
        const event: unknown = JSON.parse(row.event_json);
        if (!header) {
          header = findSessionTranscriptHeader([event]);
          if (header) {
            assertCurrentSessionTranscriptHeader(header);
          }
        }
        yield { seq: row.seq, facts: projectSessionTranscriptReportFacts(event) };
      }
    })(),
  );
  if (hasRows) {
    assertCurrentSessionTranscriptHeader(header);
  }
  return navigation;
}

export function readTranscriptReportEvent(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  seq: number,
) {
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getSessionKysely(database.db)
      .selectFrom("transcript_events")
      .select(transcriptEventJsonSql(database.db).as("event_json"))
      .where("session_id", "=", sessionId)
      .where("seq", "=", seq),
  );
  const event: unknown = row ? JSON.parse(row.event_json) : undefined;
  return asOptionalRecord(event);
}
