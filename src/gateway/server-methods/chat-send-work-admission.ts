import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { hasPendingFollowupQueueWork } from "../../auto-reply/reply/queue/state.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import type { SessionTranscriptTurnMutation } from "../../config/sessions/goals-operations.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { retireProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import {
  isCompetingSessionWorkAdmissionActive,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../talk/agent-consult-tool.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { ExpectedProfileMismatchError } from "../expected-profile.js";
import { authorizeGatewaySessionCreation, resolveCreatorSandbox } from "../operator-role-policy.js";
import { PENDING_CHAT_SEND_DEDUPE_PREFIX } from "../server-shared.js";
import { resolveOperatorSessionCreation } from "../session-creation-provenance.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { captureGatewayClientUploadCommitGuard } from "../upload-policy.js";
import { formatForLog } from "../ws-log.js";
import { readPreRegisteredRun } from "./chat-abort-authorization.js";
import {
  prepareChatSendRetryComparison,
  readChatSendDedupeResponse,
  resolveChatSendRequestConflict,
  respondChatSendAdmissionError,
  respondChatSendRetry,
  type ChatSendPreAdmissionParams,
} from "./chat-send-pre-admission.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { ChatSendRetryComparison } from "./chat-send-retry-comparison.js";
import { loadCurrentChatSendSession, type PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

/** Preparation returns facts; the caller consumes current retry ownership before reserving. */
export function prepareChatSendAdmissionRetry(params: ChatSendPreAdmissionParams) {
  try {
    return prepareChatSendRetryComparison(params)?.catch((error: unknown) => ({ error }));
  } catch (error) {
    return { error };
  }
}

export function consumeChatSendAdmissionRetry(
  params: ChatSendPreAdmissionParams,
  prepared: Awaited<ReturnType<typeof prepareChatSendAdmissionRetry>>,
) {
  try {
    if (prepared && "error" in prepared) {
      throw prepared.error;
    }
    const pending = readPreRegisteredRun({
      key: params.session.pendingChatSendKey,
      entry: params.context.dedupe.get(params.session.pendingChatSendKey),
      keyPrefix: PENDING_CHAT_SEND_DEDUPE_PREFIX,
    });
    if (pending?.payload.goalFingerprint) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Run ID is reserved by a Goal request; use a new ID.",
        ),
      );
      return false;
    }
    return !params.request.goalOperation && respondChatSendRetry(params, prepared)
      ? false
      : prepared;
  } catch (error) {
    if (error instanceof SessionMutationAuthorizationChangedError) {
      throw error;
    }
    respondChatSendAdmissionError(error, params.respond);
    return false;
  }
}

/** Reload after an actual worker wait in the consuming admission frame. */
export function prepareCurrentChatSendRetry(
  params: ChatSendPreAdmissionParams & { session: PreparedChatSendSession },
  ownPendingAttemptId: string,
) {
  const session = loadCurrentChatSendSession(params.session);
  const comparison = prepareChatSendRetryComparison(
    { ...params, session: { ...params.session, entry: session.entry } },
    ownPendingAttemptId,
  );
  return {
    comparison,
    readSession: () => (comparison ? loadCurrentChatSendSession(params.session) : session),
  };
}

export function respondChatSendWorkAdmissionFailure(
  params: ChatSendPreAdmissionParams,
  error: unknown,
  comparison?: ChatSendRetryComparison,
) {
  if (error instanceof ExpectedProfileMismatchError) {
    throw error;
  }
  const { context, respond, session } = params;
  const { clientRunId } = session;
  try {
    const conflict = resolveChatSendRequestConflict(params, comparison);
    if (conflict) {
      respond(false, undefined, conflict);
      return;
    }
  } catch {
    // Preserve the original refusal when no current comparison evidence is available.
  }
  const aborted =
    context.chatRunState.hasAbortMarker(clientRunId) &&
    readChatSendDedupeResponse(context.dedupe, clientRunId);
  if (aborted) {
    respond(aborted.ok, aborted.payload, aborted.error, { cached: true, runId: clientRunId });
    return;
  }
  respondChatSendAdmissionError(error, respond);
}

/** New input is checked only after the chat owner has reconciled prior receipts. */
export function admitChatSendUploads({
  params,
  client,
  context,
  respond,
}: Pick<GatewayRequestHandlerOptions, "params" | "client" | "context" | "respond">) {
  const assertClientUploadAllowed = captureGatewayClientUploadCommitGuard({
    method: "chat.send",
    requestParams: params,
    client,
    context,
  });
  try {
    assertClientUploadAllowed?.();
  } catch (error) {
    if (!(error instanceof SessionMutationAuthorizationChangedError)) {
      throw error;
    }
    respond(false, undefined, error.error);
    return { ok: false as const };
  }
  return { ok: true as const, assertClientUploadAllowed };
}

/** Caller and physical target custody end together when admitted work settles. */
export function releaseChatSendCallerAuthority(params: {
  operator: { release?: () => void };
  request: Pick<NormalizedChatSendRequest, "providerReviewAcknowledgment">;
  session: Pick<PreparedChatSendSession, "releaseSessionTarget">;
}): void {
  try {
    params.operator.release?.();
  } finally {
    try {
      if (params.request.providerReviewAcknowledgment) {
        retireProviderReviewAcknowledgment(params.request.providerReviewAcknowledgment);
      }
    } finally {
      params.session.releaseSessionTarget();
    }
  }
}

/** Queued and collected turns share the original session and caller admission until settlement. */
export function createChatSendWorkAdmission(params: {
  admission: Pick<SessionWorkAdmissionLease, "release">;
  releaseCallerAuthority?: () => void;
  releaseGatewayRootContinuation?: () => void;
  logGateway: Pick<GatewayRequestContext["logGateway"], "warn">;
}) {
  let references = 1;
  let finishPendingInput: (() => void | Promise<void>) | undefined;
  const releaseAdmission = () => {
    try {
      params.admission.release();
    } finally {
      try {
        params.releaseCallerAuthority?.();
      } finally {
        params.releaseGatewayRootContinuation?.();
      }
    }
  };
  const warnCleanupFailure = (error: unknown) => {
    params.logGateway.warn(`Failed to finish pending chat input: ${formatForLog(error)}`);
  };
  const release = () => {
    if (references === 0) {
      return;
    }
    references -= 1;
    if (references !== 0) {
      return;
    }
    let pending: void | Promise<void> = undefined;
    try {
      pending = finishPendingInput?.();
    } catch (error) {
      // The durable row remains recoverable; a failed disposition write must
      // not strand session/root drain ownership during shutdown.
      warnCleanupFailure(error);
    }
    if (pending) {
      // The existing admission's drain joins this write before releasing the
      // session/root fence; prompt custody has already been revoked.
      void pending.then(releaseAdmission, (error: unknown) => {
        warnCleanupFailure(error);
        releaseAdmission();
      });
    } else {
      releaseAdmission();
    }
  };
  const hold = () => {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      release();
    };
  };
  return {
    isActive: () => references > 0,
    release: hold(),
    retain: () => {
      if (references === 0) {
        throw new Error("cannot retain a released chat work admission");
      }
      references += 1;
      return hold();
    },
    setPendingInputCleanup: (finish: () => void | Promise<void>) => {
      finishPendingInput = finish;
    },
  };
}

/** Rechecked inside the session writer barrier before exclusive input is admitted. */
export function assertChatSendExclusiveAdmission(
  request: NormalizedChatSendRequest,
  session: PreparedChatSendSession,
): void {
  // Queued follow-ups get a new run id and cannot retain this consult's voice binding.
  const voiceConsult =
    request.systemInputProvenance?.kind === "internal_system" &&
    request.systemInputProvenance.sourceTool === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME;
  if (!voiceConsult && !request.goalOperation && !request.providerReviewAcknowledgment) {
    return;
  }
  const { storePath, sessionKey, backingSessionId, activeRunScopeKey } = session;
  if (
    isCompetingSessionWorkAdmissionActive(storePath, [sessionKey, backingSessionId]) ||
    hasPendingFollowupQueueWork([sessionKey, backingSessionId, activeRunScopeKey]) ||
    replyRunRegistry.isActive(activeRunScopeKey)
  ) {
    throw new Error(
      voiceConsult
        ? "Still working on the previous request. Please try again when it is finished."
        : request.providerReviewAcknowledgment
          ? "The session still has active work. Review its status before continuing."
          : "goal-session-busy",
    );
  }
}

/** Goal and initial-session policy are revalidated in the same input writer barrier. */
export function createChatSendGoalCommitGuard(
  params: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "sessionMutationAuthorization" | "sessionMutationCommitGuard"
  > & {
    admission: {
      initialSessionEntry?: SessionEntry;
      assertInitialSkillSelection?: () => void;
      activeRunAbort: Pick<ReturnType<typeof registerChatAbortController>, "controller">;
      lifecycleGeneration: ReturnType<typeof getAgentEventLifecycleGeneration>;
    };
    session: Pick<
      PreparedChatSendSession,
      | "agentId"
      | "sessionLoadKey"
      | "sessionLoadOptions"
      | "sessionKey"
      | "storePath"
      | "sessionRoutingChanged"
    >;
  },
): Pick<SessionTranscriptTurnMutation, "assertCurrent" | "routingPredicate"> & {
  assertCurrent: () => void;
} {
  const {
    admission,
    session,
    client,
    context,
    sessionMutationAuthorization,
    sessionMutationCommitGuard,
  } = params;
  const routingPredicate = admission.initialSessionEntry
    ? {
        config: structuredClone(context.getRuntimeConfig()),
        key: session.sessionLoadKey,
        agentId: session.sessionLoadOptions.agentId,
        storePath: session.storePath,
        canonicalKey: session.sessionKey,
      }
    : undefined;
  const assertCurrent = () => {
    sessionMutationCommitGuard?.();
    sessionMutationAuthorization?.assertCurrent();
    const currentConfig = context.getRuntimeConfig();
    const initialEntry = admission.initialSessionEntry;
    if (initialEntry) {
      admission.assertInitialSkillSelection?.();
      // The executor checks rows; live configuration and creator authority remain host-owned.
      if (!isDeepStrictEqual(currentConfig, routingPredicate?.config)) {
        throw new Error("Session routing changed before Goal admission; refresh and retry.");
      }
      const creationError = authorizeGatewaySessionCreation({
        cfg: currentConfig,
        client,
        agentId: session.agentId,
      });
      if (creationError) {
        throw new SessionMutationAuthorizationChangedError(creationError);
      }
      const creation = resolveOperatorSessionCreation(client);
      if (
        creation.actor?.id !== initialEntry.createdActor?.id ||
        resolveCreatorSandbox(currentConfig, creation) !== initialEntry.sandbox
      ) {
        throw new Error("Session creation policy changed before Goal admission; retry.");
      }
    }
    if (
      admission.activeRunAbort.controller.signal.aborted ||
      admission.lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
      session.sessionRoutingChanged(currentConfig)
    ) {
      throw new Error("Goal admission changed before commit; refresh and retry.");
    }
  };
  return { assertCurrent, routingPredicate };
}
