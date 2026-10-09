import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { getReplyOperationSessionReader } from "./reply-run-registry.state.js";
import type { resolveSessionConversationBindingContext } from "./session-conversation-binding.js";
import type { SessionEventExecution } from "./session-event-contract.js";

export type InitSessionStateParams = {
  providerReviewAcknowledgment?: import("../../sessions/provider-review.js").ProviderReviewAcknowledgment;
  replyOperation?: ReplyOperation;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
  ctx: FinalizedRuntimeMsgContext;
  expectedExistingSessionId?: string;
  pinExpectedExistingSession?: boolean;
  newlyCreatedSessionId?: string;
  requestedSessionId?: string;
  resumeRequestedSession?: boolean;
  signal?: AbortSignal;
  bindSessionCreation?: SessionEventExecution["bindSessionCreation"];
};

export type InitSessionStateAttemptContext = {
  agentId: string;
  conversationBinding?: SessionBindingRecord;
  conversationBindingContext: ReturnType<typeof resolveSessionConversationBindingContext>;
  isSystemEvent: boolean;
  retargetedSession: boolean;
  sessionKey: string;
  storeWriterIdentity?: string;
  sessionCtxForState: FinalizedRuntimeMsgContext;
  storePath: string;
};

export function resolveInitializationSessionReader(
  params: InitSessionStateParams,
  attemptContext: InitSessionStateAttemptContext,
) {
  const reader = getReplyOperationSessionReader(params.replyOperation);
  // A bound or command target has its own owner; never redirect the source borrow.
  if (attemptContext.retargetedSession && reader?.sessionKey !== attemptContext.sessionKey) {
    return undefined;
  }
  return reader;
}

export function resolveReplySessionInitializationOptions(
  opts: InternalGetReplyOptions | undefined,
) {
  return {
    providerReviewAcknowledgment: opts?.providerReviewAcknowledgment,
    replyOperation: opts?.replyOperation,
    ...(opts?.expectedExistingSessionId
      ? { expectedExistingSessionId: opts.expectedExistingSessionId }
      : {}),
    pinExpectedExistingSession: opts?.pinExpectedExistingSession === true,
    newlyCreatedSessionId: opts?.newlyCreatedSessionId,
    bindSessionCreation: opts?.internalEventExecution?.bindSessionCreation,
    requestedSessionId: opts?.requestedSessionId,
    resumeRequestedSession: opts?.resumeRequestedSession,
    signal: opts?.abortSignal,
  };
}
