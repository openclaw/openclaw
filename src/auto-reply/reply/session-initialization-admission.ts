import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { readConversationBindingRouteFacts } from "../../channels/conversation-binding-route-facts.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadReplySessionInitializationSnapshot } from "../../config/sessions/session-accessor.reset.js";
import { resolveSessionKey } from "../../config/sessions/session-key.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { isPluginOwnedSessionBindingRecord } from "../../plugins/conversation-binding-metadata.js";
import { isAcpSessionKey, normalizeMainKey } from "../../routing/session-key.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { shouldBypassAcpDispatchForCommand } from "./dispatch-acp-command-bypass.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { getReplyOperationSessionReader } from "./reply-run-registry.state.js";
import { resolveSessionConversationBinding } from "./session-conversation-binding.js";
import type { resolveSessionConversationBindingContext } from "./session-conversation-binding.js";
import { resolveSessionInputDeliveryKey } from "./session-delivery.js";
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
  inputDeliveryKey?: string;
  sessionCtxForState: FinalizedRuntimeMsgContext;
  storePath: string;
};

export async function resolveInitSessionStateAttemptContext(
  params: Pick<InitSessionStateParams, "cfg" | "ctx">,
  mode: "preprocessing" | "initialization",
): Promise<InitSessionStateAttemptContext> {
  const { cfg, ctx } = params;
  const {
    isSystemEvent,
    conversationBindingContext,
    commandTargetSessionKey,
    conversationBinding,
  } = await resolveSessionConversationBinding({ cfg, ctx, mode });
  // Escaped ACP commands run under the source model owner. Their handlers resolve
  // the bound target separately; initialization must not mix that key with the source owner.
  const boundSessionKey =
    conversationBinding &&
    !isPluginOwnedSessionBindingRecord(conversationBinding) &&
    !(
      isAcpSessionKey(conversationBinding.targetSessionKey) &&
      shouldBypassAcpDispatchForCommand(ctx, cfg)
    )
      ? readConversationBindingRouteFacts(ctx)?.kind === "agent"
        ? ctx.SessionKey
        : conversationBinding.targetSessionKey
      : undefined;
  const targetSessionKey = commandTargetSessionKey ?? boundSessionKey;
  const sessionCtxForState =
    targetSessionKey && targetSessionKey !== ctx.SessionKey
      ? { ...ctx, SessionKey: targetSessionKey }
      : ctx;
  const agentId = resolveSessionAgentId({
    sessionKey: sessionCtxForState.SessionKey,
    config: cfg,
    fallbackAgentId: sessionCtxForState.AgentId,
  });
  return {
    agentId,
    inputDeliveryKey: resolveSessionInputDeliveryKey(ctx),
    conversationBinding,
    conversationBindingContext,
    isSystemEvent,
    retargetedSession: sessionCtxForState !== ctx,
    sessionKey: canonicalizeMainSessionAlias({
      cfg,
      agentId,
      sessionKey: resolveSessionKey(
        cfg.session?.scope ?? "per-sender",
        sessionCtxForState,
        normalizeMainKey(cfg.session?.mainKey),
        agentId,
      ),
    }),
    sessionCtxForState,
    storePath: resolveSessionStorePathForScope({
      agentId,
      sessionKey: sessionCtxForState.SessionKey,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }),
    }),
  };
}

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

/** Reset hooks and parent forks require hot transcripts before taking the writer lane. */
export async function prepareReplySessionInitialization(
  params: InitSessionStateParams,
  attemptContext: InitSessionStateAttemptContext,
) {
  const reader = resolveInitializationSessionReader(params, attemptContext);
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    reader?.assertCurrent();
  };
  const parentSessionKey = normalizeOptionalString(params.ctx.ParentSessionKey);
  const snapshot = await loadReplySessionInitializationSnapshot(
    {
      agentId: attemptContext.agentId,
      storePath: attemptContext.storePath,
      sessionKey: attemptContext.sessionKey,
      relatedSessionKeys: parentSessionKey ? [parentSessionKey] : [],
    },
    {
      reader,
      includeColdMetadata: true,
      assertCurrent,
    },
  );
  const { restoreSessionColdTranscript } =
    await import("../../config/sessions/session-cold-storage.js");
  const restoreTargets = [
    attemptContext.sessionKey,
    ...(parentSessionKey ? [parentSessionKey] : []),
  ].map((sessionKey) => ({ sessionKey, sessionId: snapshot.readEntry(sessionKey)?.sessionId }));
  for (const { sessionKey, sessionId } of restoreTargets) {
    if (
      sessionId &&
      (snapshot.coldArchives === undefined ||
        snapshot.coldArchives.some((archive) => archive.session_id === sessionId))
    ) {
      assertCurrent();
      await restoreSessionColdTranscript(
        {
          sessionKey,
          sessionId,
          agentId: attemptContext.agentId,
          storePath: attemptContext.storePath,
        },
        assertCurrent,
      );
    }
  }
  assertCurrent();
  return parentSessionKey;
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
