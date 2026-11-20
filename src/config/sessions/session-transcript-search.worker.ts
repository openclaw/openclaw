import { expressionBuilder, sql, type Compilable, type InferResult } from "kysely";
import { admitStoreSearch } from "../../infra/database-engine/adapters.js";
import { DatabaseSearchCapabilityUnavailableError } from "../../infra/database-engine/capability-unavailable.js";
import { engineUnboundedRowLimit } from "../../infra/database-engine/row-limit.js";
import { engineStringPosition } from "../../infra/database-engine/scalar.js";
import { hasFullTextWordTokens } from "../../infra/database-engine/text-tokens.worker.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import {
  retainOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { agentTranscriptSearchSchema } from "../../state/openclaw-agent-search-schema.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  boundSessionTranscriptSearchSnippet,
  compareSessionTranscriptSearchHits,
  sessionTranscriptSearchFtsQuery,
  sessionTranscriptSearchLimit,
  validateSessionTranscriptSearchQuery,
} from "./session-transcript-search-policy.js";
import type {
  SessionTranscriptSearchParams,
  SessionTranscriptSearchReadResult,
  SessionTranscriptSearchResult,
} from "./session-transcript-search.types.js";

/** Native query kernel; projection readiness belongs to the maintenance owner. */
export function searchSessionTranscriptsReadOnlySync(
  params: SessionTranscriptSearchParams,
  preparedDatabase?: OpenClawAgentDatabaseOptions,
): SessionTranscriptSearchReadResult {
  const validated = { ...params, query: validateSessionTranscriptSearchQuery(params.query) };
  const options = preparedDatabase ?? toDatabaseOptions(resolveSqliteReadScope(params));
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteReadSnapshotSync(
        database.db,
        () => {
          const step = readSessionTranscriptSearch(database, validated, false).next();
          if (!step.done) {
            throw new Error("Unfiltered search requested host authorization");
          }
          return step.value;
        },
        { databaseLabel: database.path, operationLabel: "session transcript search" },
      ),
    options,
  );
  return result.found ? result.value : { found: false, hits: [], truncated: false };
}

/** One worker owns the cursor; only bounded candidate keys cross to the visibility owner. */
export async function searchSessionTranscriptsFiltered(
  params: SessionTranscriptSearchParams,
  options: OpenClawAgentDatabaseOptions,
  channel: WorkerTaskChannel,
  assertCurrent: () => void,
): Promise<SessionTranscriptSearchReadResult> {
  const validated = { ...params, query: validateSessionTranscriptSearchQuery(params.query) };
  const retained = retainOpenClawAgentDatabaseReadOnly(options);
  if (!retained.found) {
    return { found: false, hits: [], truncated: false };
  }
  const cursor = readSessionTranscriptSearch(retained.database, validated, true);
  try {
    let step = cursor.next();
    while (!step.done) {
      assertCurrent();
      const response = await channel.request(step.value);
      try {
        if (
          !Array.isArray(response.input) ||
          response.input.length !== step.value.length ||
          !response.input.every((value): value is boolean => typeof value === "boolean")
        ) {
          throw new Error("Invalid transcript search authorization response");
        }
        retained.claim.assertCurrent();
        step = cursor.next(response.input);
      } finally {
        response.consumed();
      }
    }
    return step.value;
  } finally {
    try {
      cursor.return({ found: false, hits: [], truncated: false });
    } finally {
      retained.claim.release();
    }
  }
}

function* readSessionTranscriptSearch(
  database: OpenClawAgentReadOnlyDatabase,
  params: SessionTranscriptSearchParams,
  filtered: boolean,
): Generator<string[], SessionTranscriptSearchReadResult, boolean[]> {
  const query = params.query;
  const limit = sessionTranscriptSearchLimit(params.limit);
  // Shared databases hold multiple logical agents. Filter before LIMIT;
  // reserved global/unknown sentinels retain their store-wide scope.
  const db = getNodeSqliteKysely<DB>(database.db);
  const postgres = isPostgresSqlConnection(database.db);
  type PageQuery<Row> = Compilable<Row> & {
    limit(count: number): PageQuery<Row>;
    offset(count: number): PageQuery<Row>;
  };
  function* iterateRows<Row>(statement: PageQuery<Row>): IterableIterator<Row> {
    if (!postgres) {
      yield* iterateSqliteQuerySync(database.db, statement);
      return;
    }
    // The PostgreSQL adapter buffers each statement; keep its authorized-candidate windows bounded too.
    for (let offset = 0; ; offset += limit + 1) {
      const page = executeSqliteQuerySync(
        database.db,
        statement.limit(limit + 1).offset(offset),
      ).rows;
      yield* page;
      if (page.length <= limit) {
        return;
      }
    }
  }
  const search = admitStoreSearch(database.db, agentTranscriptSearchSchema);
  const fullText = search.fullText;
  if (!fullText) {
    throw new DatabaseSearchCapabilityUnavailableError("fullText", search.diagnostics.join("; "));
  }
  const textIndex = search.text.transcript!;
  const fullQuery = sessionTranscriptSearchFtsQuery(query, params.match);
  const agentPrefix = toAgentStoreSessionKey({
    agentId: params.agentId,
    requestKey: "*",
  }).slice(0, -1);
  const selectedWindows = db
    .selectFrom("session_windows")
    .select(["session_id", "session_key"])
    .where((eb) =>
      params.sessionKeys === undefined
        ? eb.or([
            isPostgresSqlConnection(database.db)
              ? /* kysely-allow-raw: starts_with keeps underscores literal and, unlike left(), has planner selectivity, so the GIN match can drive the join. The prefix is a literal so reused prepared statements keep that estimate in their generic plan. */ sql<boolean>`${eb.ref("session_key")} ^@ ${sql.lit(agentPrefix)}`
              : /* kysely-allow-raw: GLOB preserves literal underscores in SQLite agent namespaces. */ sql<boolean>`${eb.ref("session_key")} GLOB ${toAgentStoreSessionKey({ agentId: params.agentId, requestKey: "*" })}`,
            eb("session_key", "in", ["global", "unknown"]),
          ])
        : params.sessionKeys.length > 0
          ? eb("session_key", "in", sqliteStringSet(params.sessionKeys))
          : eb.and([]),
    )
    .$if(params.sessionId !== undefined, (builder) =>
      builder.where("session_id", "=", params.sessionId!),
    );
  const cold = db
    .selectFrom("session_transcript_cold_archives as cold")
    .innerJoin(selectedWindows.as("window"), "window.session_id", "cold.session_id");
  let archivedTranscriptsExcluded = 0;
  if (filtered) {
    let keys: string[] = [];
    for (const row of iterateRows(
      cold
        .select("window.session_key")
        .$if(postgres, (builder) => builder.orderBy("window.session_id")),
    )) {
      keys.push(row.session_key);
      if (keys.length === 25) {
        archivedTranscriptsExcluded += (yield keys).filter(Boolean).length;
        keys = [];
      }
    }
    if (keys.length) {
      archivedTranscriptsExcluded += (yield keys).filter(Boolean).length;
    }
  } else {
    archivedTranscriptsExcluded =
      executeSqliteQueryTakeFirstSync(
        database.db,
        cold.select((eb) => eb.fn.countAll<number>().as("count")),
      )?.count ?? 0;
  }
  let substringTerms: string[] = [];
  let hits: SessionTranscriptSearchResult["hits"];
  do {
    const literalQuery = {
      ...fullQuery,
      clauses: fullQuery.clauses.filter((clause) => !substringTerms.includes(clause.text)),
    };
    const useFts =
      literalQuery.clauses.length > 0 &&
      (substringTerms.length === 0 ||
        hasFullTextWordTokens(
          database.db,
          literalQuery.clauses.map((clause) => clause.text).join(" "),
        ));
    const ranking = fullText.rank(textIndex, literalQuery);
    const expression = expressionBuilder<DB, "session_transcript_fts">();
    const match = expression.and([
      ...(useFts ? [fullText.match(textIndex, literalQuery)] : []),
      ...substringTerms.map((term) =>
        expression(
          engineStringPosition(
            database.db,
            expression.fn<string>("lower", ["text"]),
            expression.val(term.toLowerCase()),
          ),
          ">",
          0,
        ),
      ),
    ]);
    const order =
      params.order === "recent"
        ? sql`session_transcript_fts.timestamp desc, fts_rowid desc`
        : sql`rank ${/* kysely-allow-raw: Capability order is the closed asc/desc union. */ sql.raw(ranking.order)}, session_transcript_fts.timestamp desc, session_transcript_fts.message_id asc`;
    // session_key lives on the window row so key renames
    // never leave stale keys inside the index. Sessions flagged needs_rebuild
    // are excluded: their rows may still hold rewound-away branch text that
    // sessions_history no longer exposes, so they stay hidden until reconcile
    // rebuilds them (indexing=true tells the caller to retry).
    // MATCH drives indexed reads; substring scans scope map rows before reading text.
    const candidates = (
      useFts
        ? db
            .selectFrom("session_transcript_fts")
            .crossJoin("session_transcript_fts_rows as mapped")
            .crossJoin(selectedWindows.as("window"))
        : db
            .selectFrom("session_transcript_fts_rows as mapped")
            .crossJoin(selectedWindows.as("window"))
            .crossJoin("session_transcript_fts")
    )
      .where("mapped.id", "=", fullText.identity(textIndex))
      .whereRef("window.session_id", "=", "mapped.session_id")
      .where(match)
      // Depend on the scoped window so SQLite cannot read role before excluding sessions.
      .$if(Boolean(params.role), (builder) =>
        isPostgresSqlConnection(database.db)
          ? builder.where("role", "=", params.role!)
          : builder.where((eb) =>
              eb
                .case()
                .when("window.session_key", "is not", null)
                .then(eb("role", "=", params.role!))
                .else(false)
                .end(),
            ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("session_transcript_index_state")
              .select("session_id")
              .whereRef("session_id", "=", "mapped.session_id")
              .where("needs_rebuild", "!=", 0),
          ),
        ),
      )
      .select([
        "window.session_key",
        fullText.identity(textIndex).as("fts_rowid"),
        // A numeric literal keeps PostgreSQL's fallback score numeric; an untyped bind returns text.
        useFts ? ranking.value.as("rank") : sql.lit(0).as("rank"),
      ]);
    const ordered = candidates
      .select([
        "session_transcript_fts.session_id",
        "session_transcript_fts.message_id",
        "session_transcript_fts.role",
        "session_transcript_fts.timestamp",
      ])
      .$if(useFts || postgres, (builder) =>
        builder.orderBy(order).orderBy(fullText.identity(textIndex)),
      );
    const snippet = substringTerms.length
      ? expression.ref("text").as("snippet")
      : fullText.snippet(textIndex, "text", 48, literalQuery).as("snippet");
    const stream =
      filtered && !postgres && useFts && substringTerms.length === 0
        ? db
            // OFFSET prevents flattening: SQLite sorts metadata in a coroutine,
            // then computes snippets only as the visibility cursor consumes hits.
            .selectFrom(ordered.limit(engineUnboundedRowLimit(database.db)).offset(0).as("ordered"))
            .crossJoin("session_transcript_fts")
            .where((eb) => eb(fullText.identity(textIndex), "=", eb.ref("ordered.fts_rowid")))
            .where(match)
            .selectAll("ordered")
            .select(snippet)
        : ordered.select(snippet);
    const decode = (
      row: Omit<InferResult<typeof stream>[number], "fts_rowid">,
    ): SessionTranscriptSearchResult["hits"][number] | undefined => {
      if (
        typeof row.session_key !== "string" ||
        typeof row.session_id !== "string" ||
        typeof row.message_id !== "string" ||
        (row.role !== "user" && row.role !== "assistant") ||
        typeof row.snippet !== "string"
      ) {
        return undefined;
      }
      const timestamp = Number(row.timestamp);
      return {
        sessionKey: row.session_key,
        sessionId: row.session_id,
        messageId: row.message_id,
        role: row.role,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        snippet: boundSessionTranscriptSearchSnippet(row.snippet, substringTerms[0]),
        score: ranking.toRank(row.rank),
      };
    };
    if (filtered) {
      type Candidate = SessionTranscriptSearchResult["hits"][number];
      hits = [];
      let batch: Candidate[] = [];
      function* retainBatch(pending: Candidate[]): Generator<string[], void, boolean[]> {
        const allowed = yield pending.map((hit) => hit.sessionKey);
        for (const [index, hit] of pending.entries()) {
          if (!allowed[index]) {
            continue;
          }
          const position = hits.findIndex(
            (current) => compareSessionTranscriptSearchHits(hit, current) < 0,
          );
          hits.splice(position < 0 ? hits.length : position, 0, hit);
          if (hits.length > limit + 1) {
            hits.pop();
          }
        }
      }
      // Short-CJK substring fallback must finish one text pass even after finding hits:
      // timestamps are unindexed, so later rows can enter the exact newest-first top-N.
      // Only one authorization batch and limit+1 ordered hits are retained (the extra hit
      // preserves truncated); insertion keeps memory bounded independently of corpus size.
      for (const row of iterateRows(stream)) {
        const hit = decode(row);
        if (!hit) {
          continue;
        }
        const last = hits[limit];
        if (
          (useFts || postgres) &&
          last &&
          (hit.score < last.score || (hit.score === last.score && hit.timestamp < last.timestamp))
        ) {
          break;
        }
        batch.push(hit);
        if (batch.length === limit + 1) {
          yield* retainBatch(batch);
          batch = [];
        }
      }
      if (batch.length) {
        yield* retainBatch(batch);
      }
    } else {
      const selectedHits =
        params.order === "recent" || !useFts
          ? candidates.orderBy(order).limit(limit + 1)
          : db
              .with(
                (cte) => cte("scores").materialized(),
                () => candidates,
              )
              .selectFrom("scores")
              .crossJoin("session_transcript_fts")
              .where((eb) => eb(fullText.identity(textIndex), "=", eb.ref("scores.fts_rowid")))
              // Keep every tie at the cutoff before reading metadata for the final ordering.
              .where("scores.rank", "in", (eb) =>
                eb
                  .selectFrom("scores")
                  .select("rank")
                  .orderBy("rank", ranking.order)
                  .limit(limit + 1),
              )
              .select(["scores.session_key", "scores.fts_rowid", "scores.rank"])
              .orderBy("scores.rank", ranking.order)
              .orderBy("session_transcript_fts.timestamp", "desc")
              .orderBy("session_transcript_fts.message_id", "asc")
              .limit(limit + 1);
      const rows = executeSqliteQuerySync(
        database.db,
        db
          .with(
            (cte) => cte("hits").materialized(),
            () => selectedHits,
          )
          .selectFrom("hits")
          .crossJoin("session_transcript_fts")
          .where((eb) => eb(fullText.identity(textIndex), "=", eb.ref("hits.fts_rowid")))
          .where(match)
          .select([
            "hits.session_key",
            "session_transcript_fts.session_id",
            "message_id",
            "role",
            "timestamp",
            "hits.rank as rank",
            substringTerms.length
              ? expression.ref("text").as("snippet")
              : fullText.snippet(textIndex, "text", 48, literalQuery).as("snippet"),
          ])
          .orderBy(order),
      ).rows;
      hits = rows.flatMap((row) => {
        const hit = decode(row);
        return hit ? [hit] : [];
      });
    }
    if (hits.length > 0 || substringTerms.length > 0) {
      break;
    }
    // unicode61 cannot address interior CJK text. Retry only misses; changing
    // the persisted tokenizer would rebuild every existing transcript index.
    substringTerms = fullQuery.clauses
      .map((clause) => clause.text)
      .filter((term) =>
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term),
      );
  } while (substringTerms.length > 0);
  return {
    found: true,
    hits: hits.slice(0, limit),
    truncated: hits.length > limit,
    ...(archivedTranscriptsExcluded > 0 ? { archivedTranscriptsExcluded } : {}),
  };
}
