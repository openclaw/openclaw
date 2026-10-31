import { createHash } from "node:crypto";
import { resolveOptionalIntegerOption } from "@openclaw/normalization-core/number-coercion";
import type { InferResult } from "kysely";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type { TranscriptSessionDescriptor, TranscriptUtterance } from "./provider-types.js";
import {
  meetingTranscriptDb,
  meetingTranscriptSessionQuery,
  meetingTranscriptUtteranceQuery,
  type MeetingTranscriptSessionRow,
  readStoredTranscriptSummaryRevision,
  sessionFromRow,
  summaryFromRow,
  transcriptSummaryInputRevisionFromRow,
  utteranceFromRow,
} from "./store-sqlite.js";
import type { TranscriptSummarySnapshot } from "./store-types.js";
import type { TranscriptsSummary } from "./summary.js";

type TranscriptSessionIdentity = Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">;

export function readTranscriptCanonicalSessionRow(database: EngineConnection, selector: string) {
  return executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptDb(database)
      .selectFrom("meeting_transcript_sessions")
      .selectAll()
      .where("selector", "=", selector),
  );
}

export function readTranscriptExportOwnership(
  database: EngineConnection,
  session: TranscriptSessionIdentity,
) {
  return executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptSessionQuery(database, session).select([
      "export_manifest_json",
      "export_pending_json",
    ]),
  );
}

export function readTranscriptExportPathCollisions(database: EngineConnection, exportKey: string) {
  return executeSqliteQuerySync(
    database,
    meetingTranscriptDb(database)
      .selectFrom("meeting_transcript_sessions")
      .select(["session_id", "started_at", "selector", "export_pending_json"])
      .where("export_key", "=", exportKey)
      .orderBy("selector", "asc"),
  ).rows;
}

export function readTranscriptExportPathOwners(database: EngineConnection, exportKey: string) {
  return executeSqliteQuerySync(
    database,
    meetingTranscriptDb(database)
      .selectFrom("meeting_transcript_sessions")
      .select(["session_id", "started_at", "export_manifest_json", "export_pending_json"])
      .where("export_key", "=", exportKey)
      .orderBy("selector", "asc"),
  ).rows;
}

type SummarySnapshotRow = Pick<
  MeetingTranscriptSessionRow,
  | "next_utterance_seq"
  | "title"
  | "source_json"
  | "metadata_json"
  | "stopped_at"
  | "created_at_ms"
  | "updated_at_ms"
>;
const summarySnapshotQuery = createSqliteQueryCache((database: EngineConnection) =>
  prepareSqliteQueryTakeFirstSync<TranscriptSessionIdentity, SummarySnapshotRow>(
    database,
    (parameter) =>
      meetingTranscriptDb(database)
        .selectFrom("meeting_transcript_sessions")
        .where(
          "session_id",
          "=",
          parameter((value) => value.sessionId),
        )
        .where(
          "started_at",
          "=",
          parameter((value) => value.startedAt),
        )
        // Retain native integer decoding while omitting unrelated export bookkeeping.
        .select([
          "next_utterance_seq",
          "title",
          "source_json",
          "metadata_json",
          "stopped_at",
          "created_at_ms",
          "updated_at_ms",
        ]),
  ),
);

/** Runs inside the read worker's transaction so input and replacement basis agree. */
export function readTranscriptSummarySnapshot(
  database: EngineConnection,
  session: TranscriptSessionIdentity,
  maxUtterances: number,
): TranscriptSummarySnapshot | undefined {
  const row = summarySnapshotQuery(database)(session);
  if (!row) {
    return undefined;
  }
  const summaryRevision = readStoredTranscriptSummaryRevision(database, session);
  return {
    inputRevision: transcriptSummaryInputRevisionFromRow(row),
    nextSequence: row.next_utterance_seq,
    stoppedAt: row.stopped_at ?? undefined,
    summaryRevision: summaryRevision ?? "",
    utterances: readTranscriptUtterances(database, session, maxUtterances),
  };
}

export function readTranscriptSessionEntries(database: EngineConnection) {
  const rows = executeSqliteQuerySync(
    database,
    meetingTranscriptDb(database)
      .selectFrom("meeting_transcript_sessions as sessions")
      .leftJoin("meeting_transcript_summaries as summaries", (join) =>
        join
          .onRef("summaries.session_id", "=", "sessions.session_id")
          .onRef("summaries.session_started_at", "=", "sessions.started_at"),
      )
      .selectAll("sessions")
      .select((eb) => eb("summaries.session_id", "is not", null).as("has_summary"))
      .orderBy("sessions.started_at", "desc")
      .orderBy("sessions.session_id", "asc"),
  ).rows;
  return rows.map((row) => ({
    session: sessionFromRow(row),
    selector: row.selector,
    hasSummary: Boolean(row.has_summary),
  }));
}

const sessionMatchQueries = createSqliteQueryCache(createTranscriptSessionMatchQueries);

function createTranscriptSessionMatchQueries(database: EngineConnection) {
  const query = meetingTranscriptDb(database)
    .selectFrom("meeting_transcript_sessions")
    // Keep native integer validation; export ownership is not matching input.
    .select([
      "session_id",
      "started_at",
      "selector",
      "title",
      "source_json",
      "metadata_json",
      "stopped_at",
      "next_utterance_seq",
      "created_at_ms",
      "updated_at_ms",
    ])
    .select((eb) =>
      eb
        .exists(
          eb
            .selectFrom("meeting_transcript_summaries")
            .select("session_id")
            .whereRef(
              "meeting_transcript_summaries.session_id",
              "=",
              "meeting_transcript_sessions.session_id",
            )
            .whereRef(
              "meeting_transcript_summaries.session_started_at",
              "=",
              "meeting_transcript_sessions.started_at",
            ),
        )
        .as("has_summary"),
    )
    .orderBy("started_at", "desc")
    .limit(2);
  type Row = InferResult<typeof query>[number];
  return {
    canonical: prepareSqliteQuerySync<string, Row>(database, (parameter) =>
      query.where(
        "selector",
        "=",
        parameter((value) => value),
      ),
    ),
    rawId: prepareSqliteQuerySync<string, Row>(database, (parameter) =>
      query.where(
        "session_id",
        "=",
        parameter((value) => value),
      ),
    ),
    slug: prepareSqliteQuerySync<string, Row>(database, (parameter) =>
      query
        .where(
          "session_slug",
          "=",
          parameter((value) => value),
        )
        .where(
          "session_id",
          "!=",
          parameter((value) => value),
        ),
    ),
    dated: prepareSqliteQuerySync<{ sessionId: string; date: string }, Row>(database, (parameter) =>
      query
        .where(
          "session_id",
          "=",
          parameter((value) => value.sessionId),
        )
        .where(
          "started_at",
          "like",
          parameter((value) => `${value.date}T%`),
        ),
    ),
  };
}

export function readTranscriptSessionMatches(database: EngineConnection, value: string) {
  const queries = sessionMatchQueries(database);
  const entries = (result: ReturnType<typeof queries.canonical>) =>
    result.rows.map((row) => ({
      session: sessionFromRow(row),
      selector: row.selector,
      hasSummary: Boolean(row.has_summary),
      inputRevision: transcriptSummaryInputRevisionFromRow(row),
    }));
  const canonical = entries(queries.canonical(value))[0];
  const date = value.match(/^(\d{4}-\d{2}-\d{2})\//u)?.[1];
  const qualified = canonical
    ? [canonical]
    : date
      ? entries(queries.dated({ sessionId: value.slice(11), date }))
      : [];
  return {
    qualified,
    unqualified: [
      ...entries(queries.rawId(value)),
      // Exclude exact raw IDs so their historical rows cannot fill this bound
      // and hide a different identity when the tool prefers a current capture.
      ...entries(queries.slug(value)),
    ],
  };
}

export function readTranscriptSessionByIdentity(
  database: EngineConnection,
  session: TranscriptSessionIdentity,
): TranscriptSessionDescriptor | undefined {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptSessionQuery(database, session).selectAll(),
  );
  return row ? sessionFromRow(row) : undefined;
}

export function readTranscriptUtterances(
  database: EngineConnection,
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
  database: EngineConnection,
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

export function readTranscriptJsonlDigest(
  database: EngineConnection,
  session: TranscriptSessionIdentity,
): string {
  const query = meetingTranscriptUtteranceQuery(database, session)
    .selectAll()
    .orderBy("sequence", "asc");
  const digest = createHash("sha256");
  for (const row of iterateSqliteQuerySync(database, query)) {
    digest.update(`${JSON.stringify(utteranceFromRow(row))}\n`);
  }
  return digest.digest("hex");
}
