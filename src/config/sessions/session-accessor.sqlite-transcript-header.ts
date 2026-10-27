import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import type { TranscriptAppendCursor } from "./session-accessor.sqlite-transcript-append.types.js";
import { hasStoredTranscriptEvents } from "./session-accessor.sqlite-transcript-presence.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";

export function ensureTranscriptHeader(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  cwd: string | undefined,
  projection?: {
    scheduleProjectionReconcile?: boolean;
    onProjectionReconcileNeeded?: () => void;
    onPlaceholderInserted?: (placeholder: { sessionKey: string; sessionId: string }) => void;
  },
  cursor?: TranscriptAppendCursor,
): void {
  const actor = readSessionActorTransactionState(database, scope);
  if (actor && actor.hot.transcript.version.rawSeq !== null) {
    return;
  }
  const initial = actor ? undefined : cursor?.initialState;
  if (initial?.cold) {
    throw new SessionTranscriptColdError(scope.sessionId);
  }
  if (
    !actor &&
    (initial ? initial.nextSeq > 0 : hasStoredTranscriptEvents(database, scope.sessionId))
  ) {
    return;
  }
  appendTranscriptEventInTransaction(
    database,
    scope,
    createSessionTranscriptHeader({ cwd, sessionId: scope.sessionId }),
    projection,
  );
  // A newly inserted header changes sequence, generation, and projection facts.
  if (cursor) {
    cursor.initialState = undefined;
  }
}
