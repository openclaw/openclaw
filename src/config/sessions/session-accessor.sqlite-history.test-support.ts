import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import { createNestedToolActivity } from "../../sessions/nested-tool-activity.js";
import type { TranscriptAnchorPageOptions } from "../../sessions/transcript-anchor-page.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import { withRecentSessionTranscriptActiveEventsInSnapshot } from "./session-accessor.sqlite-active-events-read.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import type {
  SessionTranscriptReadScope,
  TranscriptEvent,
} from "./session-accessor.sqlite-contract.js";
import { resolveVisibleHistoryEventCount } from "./session-accessor.sqlite-history-projection.js";
import {
  readSessionTranscriptHistoryEventPageFromProjection,
  readSessionTranscriptHistoryEventByIdFromProjection,
  readSessionTranscriptHistoryAnchorPageFromProjection,
  type SessionTranscriptMessageByIdOptions,
} from "./session-accessor.sqlite-history-query.js";
import { readVisibleTranscriptStats } from "./session-accessor.sqlite-reset-window.js";
import { createTranscriptEventInserter } from "./transcript-payload.js";

export function historyMessage(
  id: string,
  parentId: string | null,
  content: unknown,
  role: "user" | "assistant" = "user",
) {
  return { type: "message", id, parentId, message: { role, content } };
}

export function historyActivity(
  options: Pick<
    Parameters<typeof createNestedToolActivity>[0],
    "afterEntryId" | "startOrder" | "toolCallId"
  > &
    Partial<Parameters<typeof createNestedToolActivity>[0]>,
) {
  return createNestedToolActivity({
    runId: "run",
    scopeId: "attempt",
    toolName: "read",
    input: {},
    result: { content: [] },
    isError: false,
    startedAt: 1,
    timestamp: 2,
    ...options,
  });
}

export function clearHistoryNavigation(database: OpenClawAgentDatabase, sessionId: string) {
  database.db
    .prepare(`UPDATE transcript_events
    SET navigation_type = NULL, navigation_custom_type = NULL,
        navigation_display = 0, message_role = NULL, navigation_last_type = NULL,
        navigation_last_custom_type = NULL, navigation_valid = 1
    WHERE session_id = ?`)
    .run(sessionId);
}

export function persistHistory(
  scope: Parameters<typeof persistSessionTranscriptTurn>[0],
  messages: Parameters<typeof persistSessionTranscriptTurn>[1]["messages"],
) {
  return persistSessionTranscriptTurn(scope, { messages, touchSessionEntry: false });
}

export function readActiveTranscriptStats(scope: SessionTranscriptReadScope) {
  return withCurrentProjectionSnapshot(scope, (projection) => {
    const { eventCount, sizeBytes } = readVisibleTranscriptStats(projection);
    return { eventCount, sizeBytes };
  });
}

export function withRecentActiveTranscriptEvents<T>(
  scope: SessionTranscriptReadScope,
  maxEvents: number,
  read: (visit: (visitor: (event: TranscriptEvent) => void) => void) => T,
): T {
  return withCurrentProjectionSnapshot(scope, (projection) =>
    withRecentSessionTranscriptActiveEventsInSnapshot(projection, maxEvents, read),
  );
}

export function useHistoryEventScope() {
  const env: NodeJS.ProcessEnv = {};
  const sessionId = "history-events-test";
  const scope = { agentId: "main", env, sessionId, sessionKey: `agent:main:${sessionId}` };
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-history-events-");
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    scope.env = { ...process.env, OPENCLAW_STATE_DIR: sessionDirs.make() };
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
  const insertEvent = createTranscriptEventInserter(database.db, sessionId);
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
            : { customType: "synthetic-notice", content: "synthetic", display: seq % 4 === 0 }
          : { message: { role: "user", content: "synthetic" } }),
      };
      insertEvent({ seq, eventJson: JSON.stringify(event), createdAt: seq });
      insertIdentity.run(sessionId, id, seq, type, seq);
      const messagePosition = isBoundary ? null : boundaries ? Math.floor(seq / 2) : seq - 1;
      insertActive.run(sessionId, seq - 1, seq, messagePosition);
    }
    const messageCount = boundaries ? count + 1 : lastSeq;
    database.db
      .prepare(
        `UPDATE session_transcript_index_state
         SET indexed_seq = ?, leaf_event_id = ?, active_event_count = ?, active_message_count = ?
         WHERE session_id = ?`,
      )
      .run(lastSeq, `synthetic-message-${lastSeq}`, lastSeq, messageCount, sessionId);
  });
}

export function readSessionTranscriptHistoryEvents(
  scope: SessionTranscriptReadScope,
  options: { readOnly?: boolean } = {},
) {
  const page = { offset: 0, maxMessages: Number.MAX_SAFE_INTEGER };
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => readSessionTranscriptHistoryEventPageFromProjection(projection, page).events,
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
) {
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => readSessionTranscriptHistoryAnchorPageFromProjection(projection, options),
    options,
  );
}
