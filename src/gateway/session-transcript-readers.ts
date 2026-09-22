import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isSessionTranscriptProjectionUnavailableError,
  visitSessionTranscriptMessageEvents,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-accessor.sqlite-active-events.js";
import { withCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-active-projection.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.sqlite-contract.js";
import { readSessionTranscriptHistoryEventCount } from "../config/sessions/session-accessor.sqlite-history-events.js";
import { readRestoredSessionTranscript } from "../config/sessions/session-cold-storage-read.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createSessionTranscriptReader } from "./session-transcript-read-kernel.js";
import {
  resolveTranscriptReadTarget,
  toTranscriptReadScope,
} from "./session-transcript-read-target.js";

export type { SessionTranscriptReadScope } from "./session-transcript-read-kernel.js";
export { capArrayByJsonBytes } from "./session-utils.fs.js";
export { attachOpenClawTranscriptMeta } from "./session-transcript-entry-message.js";
export { readSessionTranscriptVisibleMessageDeltaCore } from "../config/sessions/session-accessor.sqlite-active-events.js";

const sessionTranscriptReader = createSessionTranscriptReader({
  resolveTarget: resolveTranscriptReadTarget,
  readSnapshot: async (target, read, options) => {
    const scope = toTranscriptReadScope(target);
    return readRestoredSessionTranscript(
      scope,
      () => withCurrentProjectionSnapshot(scope, read, options),
      options,
    );
  },
});
export const {
  readSessionMessagesAsync,
  readSessionMessagesWithSourceAsync,
  readSessionMessageByIdAsync,
  readRecentSessionMessagesWithStatsAsync,
  readSessionMessagesPageWithStatsAsync,
  readSessionMessagesAroundIdWithStatsAsync,
} = sessionTranscriptReader;

/** Keep exact membership and its full-history validation in the admitted history worker. */
export async function readSessionMessagesMatchingIdAsync(
  scope: SessionTranscriptReadScope,
  messageId: string,
): Promise<unknown[]> {
  // Incognito SQLite belongs to this process and cannot be reopened in a worker.
  if (
    isIncognitoSessionKey(scope.sessionKey) ||
    (scope.storePath &&
      isIncognitoOpenClawAgentSqlitePath(scope.storePath, {
        agentId: scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey),
        env: scope.env,
      }))
  ) {
    return sessionTranscriptReader.readSessionMessagesMatchingIdAsync(scope, messageId);
  }
  const { bindSessionTranscriptStoreScope } =
    await import("../config/sessions/session-accessor.transcript-target.js");
  const { readSessionHistoryPageInWorker } =
    await import("../config/sessions/session-history-worker-runtime.js");
  const target = bindSessionTranscriptStoreScope(scope);
  return readSessionHistoryPageInWorker({
    kind: "message-lookup",
    params: {
      target: {
        agentId: target.agentId,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        storePath: target.storePath,
        sessionEntry: target.sessionEntry
          ? { sessionId: target.sessionEntry.sessionId }
          : undefined,
      },
      messageId,
    },
  });
}

/** Visits raw message payloads within the SQLite read snapshot. */
export async function visitSessionMessagesAsync(
  scope: SessionTranscriptReadScope,
  visit: (message: unknown, seq: number) => void,
): Promise<number> {
  const transcriptScope = toTranscriptReadScope(await resolveTranscriptReadTarget(scope));
  return readRestoredSessionTranscript(transcriptScope, () => {
    let count = 0;
    visitSessionTranscriptMessageEvents(transcriptScope, (entry) => {
      const message = asOptionalRecord(entry.event)?.message;
      if (message !== undefined) {
        visit(message, entry.seq);
        count += 1;
      }
    });
    return count;
  });
}

/** Counts display messages asynchronously through the reader seam. */
export async function readSessionMessageCountAsync(
  scope: SessionTranscriptReadScope,
): Promise<number> {
  const target = await resolveTranscriptReadTarget(scope);
  const transcriptScope = toTranscriptReadScope(target);
  const readCount = () =>
    readRestoredSessionTranscript(transcriptScope, () =>
      readSessionTranscriptHistoryEventCount(transcriptScope),
    );
  try {
    return await readCount();
  } catch (error) {
    if (!isSessionTranscriptProjectionUnavailableError(error)) {
      throw error;
    }
    // The failed read already scheduled the rebuild; wait before assigning
    // a sequence so a concurrent send cannot fail or reuse a stale count.
    await waitForSessionTranscriptProjection(transcriptScope);
    return await readCount();
  }
}
