import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { isTranscriptOnlyOpenClawAssistantModel } from "../../shared/transcript-only-openclaw-assistant.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type {
  LatestTranscriptAssistantMessage,
  LatestTranscriptAssistantText,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-read.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { projectAssistantTranscriptText } from "./transcript-assistant-delivery-read.js";
import { transcriptEventJsonSql, transcriptEventNavigationSql } from "./transcript-payload.js";

/** Checks physical message history without loading payloads covered by the identity index. */
export function hasSessionTranscriptMessageInDatabase(
  database: Pick<OpenClawAgentDatabase, "db" | "path">,
  sessionId: string,
): boolean {
  const db = getNodeSqliteKysely<DB>(database.db);
  // Classification can change during a concurrent rewrite. Both probes must see
  // the same snapshot or an always-present message can disappear between them.
  return readHotSessionTranscriptSnapshot(database, sessionId, "presence", () => {
    const message = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_event_identities")
        .select("seq")
        .where("session_id", "=", sessionId)
        .where("event_type", "=", "message")
        .limit(1),
    );
    if (message) {
      return true;
    }
    // Exact imports, id-less records, and nullable types need raw inspection.
    // Build the classified sequence set once; a type-selecting join can rescan
    // the covering type index for every event in a metadata-only transcript.
    const classified = db
      .selectFrom("transcript_event_identities")
      .select("seq")
      .where("session_id", "=", sessionId)
      .where("event_type", "is not", null);
    const rows = iterateSqliteQuerySync(
      database.db,
      db
        .selectFrom("transcript_events")
        .select(transcriptEventNavigationSql().as("event_json"))
        .where("session_id", "=", sessionId)
        .where("seq", "not in", classified)
        .orderBy("seq", "desc"),
    );
    return (
      findTranscriptEventInRows(
        rows,
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          event.type === "message",
      ) !== undefined
    );
  });
}

export function findTranscriptEventInRows(
  rows: Iterable<{ event_json: string }>,
  match: (event: TranscriptEvent) => boolean,
): { event: TranscriptEvent } | undefined {
  for (const row of rows) {
    try {
      const event = JSON.parse(row.event_json) as TranscriptEvent;
      if (match(event)) {
        return { event };
      }
    } catch {
      // Malformed rows are skipped, matching transcript index tolerance.
    }
  }
  return undefined;
}

export function readTranscriptHeaderFromDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  sessionId: string,
): unknown {
  return readHotSessionTranscriptSnapshot(database, sessionId, "header", () => {
    const db = getNodeSqliteKysely<DB>(database.db);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("transcript_events")
        .select(transcriptEventJsonSql(database.db).as("event_json"))
        .where("session_id", "=", sessionId)
        .orderBy("seq", "asc")
        .limit(1),
    );
    return row ? JSON.parse(row.event_json) : undefined;
  });
}

/** Read through an already admitted connection without reopening its physical store. */
export function readLatestAssistantTextFromDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  scope: Pick<ResolvedTranscriptReadScope, "agentId" | "sessionId" | "sessionKey">,
): LatestTranscriptAssistantText | undefined {
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      assertSessionTranscriptHot(database.db, scope.sessionId);
      const db = getNodeSqliteKysely<DB>(database.db);
      const beforeEventSeq = resolveSqliteSessionTranscriptReadFence({
        database,
        ...scope,
      })?.beforeRawSeq;
      const rows = iterateSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_events as te")
          .innerJoin("transcript_event_identities as ti", (join) =>
            join.onRef("ti.session_id", "=", "te.session_id").onRef("ti.seq", "=", "te.seq"),
          )
          .select(transcriptEventJsonSql(database.db, "te").as("event_json"))
          .where("te.session_id", "=", scope.sessionId)
          .where("ti.event_type", "=", "message")
          .$if(beforeEventSeq !== undefined, (query) => query.where("ti.seq", "<", beforeEventSeq!))
          .orderBy("ti.seq", "desc"),
      );
      for (const row of rows) {
        const latest = parseLatestAssistantMessageEvent(row.event_json);
        if (!latest) {
          continue;
        }
        const text = projectAssistantTranscriptText(latest.message, latest.id);
        if (text) {
          return text;
        }
      }
      return undefined;
    },
    {
      databaseLabel: database.path,
      operationLabel: "latest assistant fenced read",
    },
  );
}

function parseLatestAssistantMessageEvent(
  raw: string,
): LatestTranscriptAssistantMessage | undefined {
  let parsed: {
    id?: unknown;
    message?: { model?: unknown; provider?: unknown; role?: unknown; timestamp?: unknown };
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const message = parsed.message;
  if (!message || message.role !== "assistant") {
    return undefined;
  }
  if (isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model)) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id.trim() ? { id: parsed.id } : {}),
    message,
  };
}
