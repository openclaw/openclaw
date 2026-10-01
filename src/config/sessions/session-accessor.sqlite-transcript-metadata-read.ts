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
} from "./session-accessor.sqlite-contract.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-read.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { projectAssistantTranscriptText } from "./transcript-assistant-delivery-read.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

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
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
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
        const latest = parseLatestAssistantMessageEvent(row.event_json, options);
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
  options: { includeTranscriptOnlyOpenClawAssistant?: boolean } = {},
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
  if (
    !options.includeTranscriptOnlyOpenClawAssistant &&
    isTranscriptOnlyOpenClawAssistantModel(message.provider, message.model)
  ) {
    return undefined;
  }
  return {
    ...(typeof parsed.id === "string" && parsed.id.trim() ? { id: parsed.id } : {}),
    message,
  };
}
