import { randomUUID } from "node:crypto";
import {
  persistSessionTranscriptTurn,
  readActiveTranscriptEntryAnchor,
  type SessionTranscriptTurnPersistOptions,
} from "../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import {
  copyTranscriptEntryProvenance,
  copyTranscriptMessageProvenanceToAnchor,
} from "../config/sessions/transcript-entry-provenance.js";
import { isUserMessage, resolvePersistedUserTurnMessage } from "./user-turn-transcript.message.js";
import { preparePersistedUserTurnMessageForTranscriptWrite } from "./user-turn-transcript.metadata.js";
import type {
  PersistUserTurnTranscriptParams,
  PersistedUserTurnMessage,
  UserTurnTranscriptPersistResult,
} from "./user-turn-transcript.types.js";

// Store-backed persistence resolves the current session transcript file lazily
// so callers can pass a session entry/store without knowing the final path.
export async function persistUserTurnTranscript(
  params: PersistUserTurnTranscriptParams,
): Promise<UserTurnTranscriptPersistResult | undefined> {
  const message = resolvePersistedUserTurnMessage(params);
  if (!message) {
    return undefined;
  }
  let committedWithoutAnchor = false;
  // SAFETY: Core recorder callers supply their admitted runtime config; the lightweight target keeps it opaque.
  const config = params.config as SessionTranscriptTurnPersistOptions["config"];

  const turn = await persistSessionTranscriptTurn(
    {
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionEntry: params.sessionEntry,
      ...(params.sessionStore ? { sessionStore: params.sessionStore } : {}),
      ...(params.storePath ? { storePath: params.storePath } : {}),
      agentId: params.agentId,
      ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
    },
    {
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.config ? { config } : {}),
      ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
      ...(params.expectedLifecycleRevision !== undefined
        ? { expectedLifecycleRevision: params.expectedLifecycleRevision }
        : {}),
      ...(params.assertCurrent ? { assertCurrent: params.assertCurrent } : {}),
      ...(params.initialSessionEntry ? { initialSessionEntry: params.initialSessionEntry } : {}),
      ...(params.expectedSessionState ? { expectedSessionState: params.expectedSessionState } : {}),
      ...(params.sessionLifecyclePatch
        ? { sessionLifecyclePatch: params.sessionLifecyclePatch }
        : {}),
      ...(params.sessionTurnMutation ? { sessionTurnMutation: params.sessionTurnMutation } : {}),
      updateMode: params.updateMode ?? "inline",
      onMessageCommitted: (result) => {
        if (!result.appended || !isUserMessage(result.message)) {
          return;
        }
        if (result.anchor) {
          params.onOriginalInputCommitted?.({ message: result.message, anchor: result.anchor });
        } else {
          committedWithoutAnchor = true;
        }
      },
      messages: [
        {
          message,
          idempotencyLookup: "scan",
          workerPreparation: {
            beforeFreshMessageCommit: params.beforeFreshMessageCommit,
            prepareMessageAfterIdempotencyCheck: (candidate) =>
              preparePersistedUserTurnMessageForTranscriptWrite(
                // SAFETY: This callback receives the single original-input message selected above.
                candidate as PersistedUserTurnMessage,
                params,
              ),
          },
        },
      ],
    },
  );
  const result = turn.messages[0];
  if (!result || !isUserMessage(result.message)) {
    return undefined;
  }
  let appended = { ...result, message: result.message };
  if (!appended.anchor) {
    await waitForSessionTranscriptProjection(params);
    const anchor = readActiveTranscriptEntryAnchor({ ...params, entryId: appended.messageId });
    appended = anchor ? { ...appended, anchor } : appended;
  }
  if (!appended.anchor || appended.message.role !== "user") {
    return undefined;
  }
  copyTranscriptMessageProvenanceToAnchor(result, appended.anchor);
  if (committedWithoutAnchor && appended.appended) {
    // A deferred projection supplies its anchor later; only the captured fresh
    // append may complete here, never an idempotent history match.
    params.onOriginalInputCommitted?.({ message: appended.message, anchor: appended.anchor });
  }

  const admission = {
    ...appended.anchor,
    logicalTurnId: params.logicalTurnId ?? randomUUID(),
    role: "user" as const,
  };
  copyTranscriptEntryProvenance(appended.anchor, admission);
  return {
    ...appended,
    admission,
    sessionEntry: turn.sessionEntry,
    ...(turn.sessionTurnMutationResult
      ? { sessionTurnMutationResult: turn.sessionTurnMutationResult }
      : {}),
    sessionFile: params.sessionKey,
  };
}
