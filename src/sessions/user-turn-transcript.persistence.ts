import { randomUUID } from "node:crypto";
import {
  persistSessionTranscriptTurn,
  publishTranscriptUpdate,
  readActiveTranscriptEntryAnchor,
  rewriteTranscriptMessageAtAnchor,
} from "../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { isUserMessage, resolvePersistedUserTurnMessage } from "./user-turn-transcript.message.js";
import {
  normalizePersistedSteerTargetRunId,
  preparePersistedUserTurnMessageForTranscriptWrite,
  rewritePersistedSteerTargetRunId,
} from "./user-turn-transcript.metadata.js";
import type {
  PersistUserTurnTranscriptParams,
  PersistedUserTurnMessage,
  UserTurnTranscriptAdmissionReceipt,
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
      ...(params.config ? { config: params.config } : {}),
      ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
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
          prepareMessageAfterIdempotencyCheck: (candidate) => {
            if (!isUserMessage(candidate)) {
              throw new Error("User turn transcript preparation requires a user message.");
            }
            return preparePersistedUserTurnMessageForTranscriptWrite(candidate, params);
          },
        },
      ],
    },
  );
  const appended = turn.messages[0];
  if (!appended || !isUserMessage(appended.message)) {
    return undefined;
  }
  let anchor = appended.anchor;
  if (!anchor) {
    await waitForSessionTranscriptProjection(params);
    anchor = readActiveTranscriptEntryAnchor({ ...params, entryId: appended.messageId });
  }
  if (!anchor) {
    return undefined;
  }
  if (committedWithoutAnchor && appended.appended) {
    // A deferred projection supplies its anchor later; only the captured fresh
    // append may complete here, never an idempotent history match.
    params.onOriginalInputCommitted?.({ message: appended.message, anchor });
  }

  const committed = { ...appended, anchor, message: appended.message };
  return {
    ...committed,
    admission: {
      ...anchor,
      logicalTurnId: params.logicalTurnId ?? randomUUID(),
      role: "user",
    },
    sessionEntry: turn.sessionEntry,
    ...(turn.sessionTurnMutationResult
      ? { sessionTurnMutationResult: turn.sessionTurnMutationResult }
      : {}),
    sessionFile: params.sessionKey,
  };
}

export async function confirmPersistedSteerTargetRunId(params: {
  admission: UserTurnTranscriptAdmissionReceipt;
  targetRunId: string;
}): Promise<
  | {
      admission: UserTurnTranscriptAdmissionReceipt;
      message: PersistedUserTurnMessage;
    }
  | undefined
> {
  const rewritten = await rewriteTranscriptMessageAtAnchor(params.admission, (message) => {
    if (!isUserMessage(message)) {
      return undefined;
    }
    const currentTarget = normalizePersistedSteerTargetRunId(
      message["__openclaw"]?.steerTargetRunId,
    );
    return currentTarget === params.targetRunId
      ? undefined
      : rewritePersistedSteerTargetRunId(message, params.targetRunId);
  });
  if (!rewritten) {
    return undefined;
  }
  const admission = { ...params.admission, generation: rewritten.generation };
  await publishTranscriptUpdate(admission, {
    message: rewritten.message,
    messageId: admission.entryId,
    messageSeq: admission.activeMessagePosition + 1,
  });
  return { admission, message: rewritten.message };
}
