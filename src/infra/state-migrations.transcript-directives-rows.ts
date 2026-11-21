import { expressionBuilder, sql } from "kysely";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "./kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "./sql-connection.js";
import type { MaskedProviderResolver } from "./state-migrations.transcript-directives-providers.js";
import {
  type HistoricalTranscriptLineResult,
  type HistoricalTranscriptRepairScope,
  MASKED_PROVIDER_JSON,
  repairHistoricalTranscriptEventJson,
} from "./state-migrations.transcript-directives-transform.js";

const TRANSCRIPT_REPAIR_BATCH_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_REPAIR_BATCH_ROWS = 64;
type TranscriptDirectiveMigrationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "transcript_events" | "session_transcript_cold_archives"
>;

type TranscriptRowPlan = {
  directivesChanged: boolean;
  eventJson: string;
  maskedProvider?: HistoricalTranscriptLineResult["maskedProvider"];
  rewrittenEventJson: string;
  seq: number;
};

/**
 * Candidate rows without decoding every payload. Identity rows hold the masked value in
 * `event_json`; compressed rows always carry a navigation projection that keeps
 * `message.provider`, so only matching compressed rows are decoded.
 */
function transcriptCandidateFilter(
  database: EngineConnection,
  scope: HistoricalTranscriptRepairScope,
) {
  const maskedProvider = isPostgresSqlConnection(database)
    ? /* kysely-allow-raw: substring prefilter over stored JSON columns; parsed events decide. */ sql<boolean>`(strpos(transcript_events.event_json, ${MASKED_PROVIDER_JSON}) > 0 OR strpos(transcript_events.navigation_json, ${MASKED_PROVIDER_JSON}) > 0)`
    : /* kysely-allow-raw: substring prefilter over stored JSON columns; parsed events decide. */ sql<boolean>`(instr(transcript_events.event_json, ${MASKED_PROVIDER_JSON}) > 0 OR instr(transcript_events.navigation_json, ${MASKED_PROVIDER_JSON}) > 0)`;
  const candidate =
    scope === "masked-provider"
      ? maskedProvider
      : /* kysely-allow-raw: directive rows still need the decoded payload predicate. */ sql<boolean>`(${transcriptEventJsonSql(database)} LIKE '%[[%' OR ${maskedProvider})`;
  const eb = expressionBuilder<TranscriptDirectiveMigrationDatabase, "transcript_events">();
  // Cold payloads remain archive-owned, including exceptional inline representations.
  const hot = eb(
    "transcript_events.session_id",
    "not in",
    eb.selectFrom("session_transcript_cold_archives").select("session_id"),
  );
  return eb.case().when(hot).then(candidate).else(sql.lit(false)).end();
}

/**
 * Candidate sessions after the cursor, from one rowid-order scan. Ordering, DISTINCT or a
 * session range would walk the primary-key index and fetch every row out of order, which
 * is several times slower on large databases.
 */
export function listTranscriptCandidateSessions(
  database: EngineConnection,
  scope: HistoricalTranscriptRepairScope,
  afterSessionId: string,
): string[] {
  const db = getNodeSqliteKysely<TranscriptDirectiveMigrationDatabase>(database);
  const postgres = isPostgresSqlConnection(database);
  const candidate = transcriptCandidateFilter(database, scope);
  const sessions = new Set<string>();
  // A decoded WHERE can retain every UDF allocation in one native step, even
  // with iterate(). Return each evaluated row so the native handle scope ends.
  for (const row of iterateSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select(["session_id", postgres ? sql.lit(true).as("candidate") : candidate.as("candidate")])
      // PostgreSQL has no JS decoder and its bridge buffers results; retain its native filter.
      .$if(postgres, (query) => query.where(candidate)),
  )) {
    if (row.candidate && row.session_id > afterSessionId) {
      sessions.add(row.session_id);
    }
  }
  return [...sessions].toSorted();
}

export function* planTranscriptSession(params: {
  database: EngineConnection;
  pathname: string;
  resolveMaskedProvider: MaskedProviderResolver;
  scope: HistoricalTranscriptRepairScope;
  sessionId: string;
}): Generator<{ rows: TranscriptRowPlan[]; complete: boolean }> {
  const { database, scope, sessionId } = params;
  const db = getNodeSqliteKysely<TranscriptDirectiveMigrationDatabase>(database);
  const postgres = isPostgresSqlConnection(database);
  const candidate = transcriptCandidateFilter(database, scope);
  const resolveMaskedProvider = params.resolveMaskedProvider(params.sessionId);
  let planned: TranscriptRowPlan[] = [];
  let bytes = 0;
  for (const row of iterateSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select((eb) => [
        "seq",
        postgres
          ? transcriptEventJsonSql(database).as("event_json")
          : eb
              .case()
              .when(candidate)
              .then(transcriptEventJsonSql(database))
              .else(null)
              .end()
              .as("event_json"),
      ])
      .where("session_id", "=", sessionId)
      .$if(postgres, (query) => query.where(candidate))
      .orderBy("seq", "asc"),
  )) {
    if (row.event_json === null) {
      continue;
    }
    const repaired = repairHistoricalTranscriptEventJson({
      raw: row.event_json,
      owner: `${params.pathname}:${params.sessionId}:${row.seq}`,
      scope: params.scope,
      resolveMaskedProvider,
    });
    const rowBytes = Buffer.byteLength(row.event_json) + Buffer.byteLength(repaired.content);
    if (planned.length > 0 && bytes + rowBytes > TRANSCRIPT_REPAIR_BATCH_BYTES) {
      yield { rows: planned, complete: false };
      planned = [];
      bytes = 0;
    }
    planned.push({
      directivesChanged: repaired.directivesChanged,
      eventJson: row.event_json,
      maskedProvider: repaired.maskedProvider,
      rewrittenEventJson: repaired.content,
      seq: row.seq,
    });
    bytes += rowBytes;
    if (planned.length >= TRANSCRIPT_REPAIR_BATCH_ROWS || bytes >= TRANSCRIPT_REPAIR_BATCH_BYTES) {
      yield { rows: planned, complete: false };
      planned = [];
      bytes = 0;
    }
  }
  // An empty final batch still commits the session cursor after its last repair.
  yield { rows: planned, complete: true };
}
