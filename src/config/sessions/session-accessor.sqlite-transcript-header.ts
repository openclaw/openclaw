import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { hasStoredTranscriptEvents } from "./session-accessor.sqlite-transcript-presence.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
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
): void {
  const actor = readSessionActorTransactionState(database, scope);
  if (actor && actor.hot.transcript.version.rawSeq !== null) {
    return;
  }
  if (!actor && hasStoredTranscriptEvents(database, scope.sessionId)) {
    return;
  }
  appendTranscriptEventInTransaction(
    database,
    scope,
    createSessionTranscriptHeader({ cwd, sessionId: scope.sessionId }),
    projection,
  );
}
