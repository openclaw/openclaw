import type { DatabaseSync } from "node:sqlite";
import { resolveOptionalIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import {
  meetingTranscriptDb,
  meetingTranscriptSessionQuery,
  meetingTranscriptUtteranceQuery,
  type MeetingTranscriptSessionRow,
  readTranscriptSummaryKeys,
  sessionFromRow,
  summaryFromRow,
  transcriptSummaryInputRevisionFromRow,
  utteranceFromRow,
} from "./store-sqlite.js";
import type { TranscriptsSummary } from "./summary.js";

type TranscriptSessionIdentity = Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">;
type TranscriptSessionEntry = {
  session: TranscriptSessionDescriptor;
  selector: string;
  hasSummary: boolean;
};
type TranscriptSessionMatchEntry = TranscriptSessionEntry & { inputRevision: string };

export function readTranscriptSessionEntries(database: DatabaseSync): TranscriptSessionEntry[] {
  const rows = executeSqliteQuerySync(
    database,
    meetingTranscriptDb(database)
      .selectFrom("meeting_transcript_sessions")
      .selectAll()
      .orderBy("started_at", "desc")
      .orderBy("session_id", "asc"),
  ).rows;
  const summaryKeys = readTranscriptSummaryKeys(database);
  return rows.map((row) => ({
    session: sessionFromRow(row),
    selector: row.selector,
    hasSummary: summaryKeys.has(`${row.session_id}\0${row.started_at}`),
  }));
}

export function readTranscriptSessionMatches(
  database: DatabaseSync,
  value: string,
): {
  qualified: TranscriptSessionMatchEntry[];
  unqualified: TranscriptSessionMatchEntry[];
} {
  const query = meetingTranscriptDb(database)
    .selectFrom("meeting_transcript_sessions")
    .selectAll()
    .orderBy("started_at", "desc")
    .limit(2);
  const matchedEntry = (row: MeetingTranscriptSessionRow): TranscriptSessionMatchEntry => {
    const hasSummary = Boolean(
      executeSqliteQueryTakeFirstSync(
        database,
        meetingTranscriptDb(database)
          .selectFrom("meeting_transcript_summaries")
          .select("session_id")
          .where("session_id", "=", row.session_id)
          .where("session_started_at", "=", row.started_at)
          .limit(1),
      ),
    );
    return {
      session: sessionFromRow(row),
      selector: row.selector,
      hasSummary,
      inputRevision: transcriptSummaryInputRevisionFromRow(row),
    };
  };
  const entries = (selection: typeof query) =>
    executeSqliteQuerySync(database, selection).rows.map(matchedEntry);
  const canonical = executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptDb(database)
      .selectFrom("meeting_transcript_sessions")
      .selectAll()
      .where("selector", "=", value),
  );
  const date = value.match(/^(\d{4}-\d{2}-\d{2})\//u)?.[1];
  const qualified = canonical
    ? [matchedEntry(canonical)]
    : date
      ? entries(
          query.where("session_id", "=", value.slice(11)).where("started_at", "like", `${date}T%`),
        )
      : [];
  return {
    qualified,
    unqualified: [
      ...entries(query.where("session_id", "=", value)),
      // Exclude exact raw IDs so their historical rows cannot fill this bound
      // and hide a different identity when the tool prefers a current capture.
      ...entries(query.where("session_slug", "=", value).where("session_id", "!=", value)),
    ],
  };
}

export function readTranscriptSessionByIdentity(
  database: DatabaseSync,
  session: TranscriptSessionIdentity,
): TranscriptSessionDescriptor | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptSessionQuery(database, session).selectAll(),
  );
  return row ? sessionFromRow(row) : undefined;
}

export function readTranscriptUtterances(
  database: DatabaseSync,
  session: TranscriptSessionIdentity,
  maxUtterances?: number,
): TranscriptUtterance[] {
  const limit = resolveOptionalIntegerOption(maxUtterances, { min: 1 });
  const query = meetingTranscriptUtteranceQuery(database, session).selectAll();
  if (limit === undefined) {
    return executeSqliteQuerySync(database, query.orderBy("sequence", "asc")).rows.map(
      utteranceFromRow,
    );
  }
  return executeSqliteQuerySync(database, query.orderBy("sequence", "desc").limit(limit))
    .rows.toReversed()
    .map(utteranceFromRow);
}

export function readStoredTranscriptSummary(
  database: DatabaseSync,
  session: TranscriptSessionIdentity,
): { summary?: TranscriptsSummary; markdown?: string } {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptDb(database)
      .selectFrom("meeting_transcript_summaries")
      .selectAll()
      .where("session_id", "=", session.sessionId)
      .where("session_started_at", "=", session.startedAt),
  );
  if (!row) {
    return {};
  }
  const summary = summaryFromRow(row);
  return {
    ...(summary ? { summary } : {}),
    ...(row.markdown !== null ? { markdown: row.markdown } : {}),
  };
}
