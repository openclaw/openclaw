import { randomUUID } from "node:crypto";
import {
  persistSessionTranscriptTurn,
  type SessionTranscriptTurnPersistOptions,
  type TranscriptMessageAppendResult,
} from "../config/sessions/session-accessor.js";
import { readActiveTranscriptEntryAnchorAsync } from "../config/sessions/session-transcript-anchor-read.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { captureOwnedTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import { isUserMessage, resolvePersistedUserTurnMessage } from "./user-turn-transcript.message.js";
import { preparePersistedUserTurnMessageForTranscriptWrite } from "./user-turn-transcript.metadata.js";
import type {
  PersistUserTurnTranscriptParams,
  PersistedUserTurnMessage,
  UserTurnTranscriptPersistResult,
} from "./user-turn-transcript.types.js";

export type CommittedUserTurnTranscript = TranscriptMessageAppendResult<PersistedUserTurnMessage> &
  Pick<UserTurnTranscriptPersistResult, "sessionEntry" | "sessionTurnMutationResult">;

export function admittedUserTurnResult(
  committed: CommittedUserTurnTranscript,
  logicalTurnId: string,
  sessionKey: string,
): UserTurnTranscriptPersistResult | undefined {
  if (!committed.anchor) {
    return undefined;
  }
  return {
    ...committed,
    admission: { ...committed.anchor, logicalTurnId, role: "user" },
    sessionFile: sessionKey,
  };
}

export async function resolveCommittedUserTurnTranscript(
  originalCommit: CommittedUserTurnTranscript,
  params: PersistUserTurnTranscriptParams,
): Promise<UserTurnTranscriptPersistResult | undefined> {
  let committed = originalCommit;
  if (!committed.anchor) {
    const assertCurrent = captureOwnedTranscriptWriteAssertion(params);
    await waitForSessionTranscriptProjection(params);
    const anchor = await readActiveTranscriptEntryAnchorAsync({
      ...params,
      entryId: committed.messageId,
    });
    assertCurrent();
    if (anchor) {
      committed = { ...committed, anchor };
    }
  }
  return admittedUserTurnResult(committed, params.logicalTurnId ?? randomUUID(), params.sessionKey);
}

// Store-backed persistence resolves the current session transcript file lazily
// so callers can pass a session entry/store without knowing the final path.
export async function persistUserTurnTranscript(
  params: PersistUserTurnTranscriptParams & {
    onCommitted?: (
      committed: CommittedUserTurnTranscript,
      acceptCompletion: (complete: () => Promise<void>) => void,
    ) => void;
  },
): Promise<UserTurnTranscriptPersistResult | undefined> {
  const message = resolvePersistedUserTurnMessage(params);
  if (!message) {
    return undefined;
  }
  let committedWithoutAnchor = false;

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
      ...(params.config
        ? {
            // SAFETY: Recorder targets carry the host's loaded config; their public contract keeps it opaque.
            config: params.config as SessionTranscriptTurnPersistOptions["config"],
          }
        : {}),
      ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
      ...(params.initialSessionEntry ? { initialSessionEntry: params.initialSessionEntry } : {}),
      ...(params.expectedSessionState ? { expectedSessionState: params.expectedSessionState } : {}),
      ...(params.sessionLifecyclePatch
        ? { sessionLifecyclePatch: params.sessionLifecyclePatch }
        : {}),
      ...(params.sessionTurnMutation ? { sessionTurnMutation: params.sessionTurnMutation } : {}),
      updateMode: params.updateMode ?? "inline",
      onMessageCommitted: (result, acceptCompletion, committedTurn) => {
        if (!isUserMessage(result.message)) {
          return;
        }
        if (committedTurn) {
          params.onCommitted?.(
            { ...result, message: result.message, ...committedTurn },
            acceptCompletion,
          );
        }
        if (!result.appended) {
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
                // SAFETY: Preparation receives the typed user message above; goal preparation only adds metadata.
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
  const appended = await resolveCommittedUserTurnTranscript(
    {
      ...result,
      message: result.message,
      sessionEntry: turn.sessionEntry,
      sessionTurnMutationResult: turn.sessionTurnMutationResult,
    },
    params,
  );
  if (!appended) {
    return undefined;
  }
  if (committedWithoutAnchor && appended.appended) {
    // A deferred projection supplies its anchor later; only the captured fresh
    // append may complete here, never an idempotent history match.
    params.onOriginalInputCommitted?.({ message: appended.message, anchor: appended.admission });
  }

  return appended;
}
