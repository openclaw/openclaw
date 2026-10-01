import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import type { TranscriptAnchorPageOptions } from "../../sessions/transcript-anchor-page.js";
import {
  closeOpenClawAgentDatabasesForTest,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { SessionTranscriptMessageAnchorPage } from "./session-accessor.sqlite-active-events.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { resolveVisibleHistoryEventCount } from "./session-accessor.sqlite-history-projection.js";
import {
  readSessionTranscriptHistoryEventsFromProjection,
  readSessionTranscriptHistoryEventByIdFromProjection,
  readSessionTranscriptHistoryAnchorPageFromProjection,
  type SessionTranscriptMessageByIdOptions,
} from "./session-accessor.sqlite-history-query.js";
import type { SessionTranscriptMessageEvent } from "./session-accessor.sqlite-projection-read.js";

export function useHistoryEventScope() {
  const env: NodeJS.ProcessEnv = {};
  const scope = {
    agentId: "main",
    env,
    sessionId: "history-events-test",
    sessionKey: "agent:main:history-events-test",
  };
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      vi.restoreAllMocks();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });
  beforeEach(() => {
    scope.env = {
      ...process.env,
      OPENCLAW_STATE_DIR: tempDirs.make("openclaw-history-events-"),
    };
  });
  return scope;
}

export function historyEventId(entry: { event: unknown } | undefined): unknown {
  const event = entry?.event;
  return event && typeof event === "object" && "id" in event ? event.id : undefined;
}

export function insertSyntheticHistory(
  database: OpenClawAgentDatabase,
  sessionId: string,
  count: number,
  boundaries = false,
  boundaryType: "compaction" | "custom_message" = "compaction",
): void {
  const lastSeq = count * (boundaries ? 2 : 1) + 1;
  const insertEvent = database.db.prepare(
    "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
  );
  const insertIdentity = database.db.prepare(
    `INSERT INTO transcript_event_identities
       (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
  );
  const insertActive = database.db.prepare(
    `INSERT INTO session_transcript_active_events
       (session_id, active_position, event_seq, message_position, context_eligible)
     VALUES (?, ?, ?, ?, 1)`,
  );
  runSqliteImmediateTransactionSync(database.db, () => {
    for (let seq = 2; seq <= lastSeq; seq += 1) {
      const isBoundary = boundaries && seq % 2 === 0;
      const id = `synthetic-${isBoundary ? "boundary" : "message"}-${String(seq)}`;
      const type = isBoundary ? boundaryType : "message";
      const event = {
        type,
        id,
        parentId: null,
        timestamp: "2026-08-15T00:00:00.000Z",
        ...(isBoundary
          ? boundaryType === "compaction"
            ? { summary: "synthetic" }
            : {
                customType: "synthetic-notice",
                content: "synthetic",
                display: seq % 4 === 0,
              }
          : { message: { role: "user", content: "synthetic" } }),
      };
      insertEvent.run(sessionId, seq, JSON.stringify(event), seq);
      insertIdentity.run(sessionId, id, seq, type, seq);
      insertActive.run(
        sessionId,
        seq - 1,
        seq,
        isBoundary ? null : boundaries ? Math.floor(seq / 2) : seq - 1,
      );
    }
    database.db
      .prepare(
        `UPDATE session_transcript_index_state
         SET indexed_seq = ?, leaf_event_id = ?, active_event_count = ?, active_message_count = ?
         WHERE session_id = ?`,
      )
      .run(
        lastSeq,
        `synthetic-message-${String(lastSeq)}`,
        lastSeq,
        boundaries ? count + 1 : lastSeq,
        sessionId,
      );
  });
}

export function readSessionTranscriptHistoryEvents(
  scope: SessionTranscriptReadScope,
  options: { readOnly?: boolean } = {},
): SessionTranscriptMessageEvent[] {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => readSessionTranscriptHistoryEventsFromProjection(projection),
    options,
  );
}

export function readSessionTranscriptHistoryEventCount(scope: SessionTranscriptReadScope): number {
  return withCurrentProjectionSnapshot(scope, resolveVisibleHistoryEventCount);
}

export function readSessionTranscriptHistoryEventById(
  scope: SessionTranscriptReadScope,
  eventId: string,
  options: SessionTranscriptMessageByIdOptions = {},
) {
  return withCurrentProjectionSnapshot(scope, (projection) =>
    readSessionTranscriptHistoryEventByIdFromProjection(projection, eventId, options),
  );
}

export function readSessionTranscriptHistoryAnchorPage(
  scope: SessionTranscriptReadScope,
  options: TranscriptAnchorPageOptions & { readOnly?: boolean },
): SessionTranscriptMessageAnchorPage {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => readSessionTranscriptHistoryAnchorPageFromProjection(projection, options),
    options,
  );
}
