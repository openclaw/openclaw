import type {
  InternalGetReplyOptions,
  ReplySessionBinding,
} from "../../auto-reply/reply/get-reply.types.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { adoptExecRequestSession } from "../../infra/exec-request-context.js";
import {
  captureSessionTarget,
  type SessionEffectRef,
} from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceIdentity,
  isRpcSourceRegistered,
  updateRpcSourceSessionId,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import { bindSessionControllerEntryTarget } from "../../sessions/session-controller.state.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

// Native initialization may create the SID after admission. Only the original
// registration can adopt it; retained callbacks cannot bind a successor.
export function bindChatSendPreparedSession(params: {
  runId: string;
  sessionKey: string;
  sourceRef: RpcSourceRef;
  lifecycleGeneration: string;
  admission: Pick<SessionEffectRef, "isActive">;
}): (binding: ReplySessionBinding) => void {
  const { sourceRef } = params;
  // The controller can adopt its new SID before this request context is rebound.
  let requestSessionId = getRpcSourceIdentity(sourceRef).sessionId;
  return (binding) => {
    const input = sourceRef.input;
    const operation = input.claim?.operation;
    if (binding.sessionKey !== params.sessionKey) {
      return;
    }
    if (
      !isRpcSourceRegistered(sourceRef) ||
      params.lifecycleGeneration !== getAgentEventLifecycleGeneration() ||
      !params.admission.isActive() ||
      input.abortSignal.aborted ||
      input.phase === "consumed" ||
      input.retirementRequested ||
      input.custody.cancellationRetired ||
      input.withdrawalHolds > 0 ||
      operation?.abortFrozen ||
      operation?.result ||
      sourceRef.adapter.projectSessionTerminalPending ||
      sourceRef.adapter.projectSessionTerminalPersisted
    ) {
      throw createAbortError("chat session preparation no longer owns its admission");
    }
    adoptExecRequestSession({
      runId: params.runId,
      previousSessionId: requestSessionId,
      sessionId: binding.sessionId,
    });
    const owner = input.mailbox.owner;
    const target = owner.target;
    if (!target) {
      throw new Error("Prepared RPC source lost its physical target");
    }
    bindSessionControllerEntryTarget(
      owner,
      captureSessionTarget({
        storeScope: target.storeScope,
        sessionKey: target.sessionKey,
        aliases: target.aliases,
        agentId: target.agentId,
        incarnation: binding.sessionId,
      }),
    );
    updateRpcSourceSessionId(sourceRef, binding.sessionId);
    requestSessionId = binding.sessionId;
  };
}

export function createChatSendSessionInitialization(params: {
  sessionKey: string;
  agentId: string;
  needsCreationBinding: boolean;
  authorization: GatewayRequestHandlerOptions["sessionMutationAuthorization"];
  getSessionInitializationOptions: () => Pick<
    InternalGetReplyOptions,
    | "requestedSessionId"
    | "resumeRequestedSession"
    | "expectedExistingSessionId"
    | "pinExpectedExistingSession"
    | "newlyCreatedSessionId"
    | "recordedSessionActivity"
  >;
}): () => ReturnType<typeof params.getSessionInitializationOptions> &
  Pick<
    InternalGetReplyOptions,
    "bindSessionCreation" | "onDatabaseRegistration" | "onSessionCreated"
  > {
  const { authorization } = params;
  const target = { sessionKey: params.sessionKey, agentId: params.agentId };
  return () => ({
    ...params.getSessionInitializationOptions(),
    onDatabaseRegistration: authorization?.followRegistration
      ? (change) => authorization.followRegistration?.(target, change)
      : undefined,
    ...(params.needsCreationBinding && authorization?.bindCreation
      ? {
          bindSessionCreation: (operation) => {
            authorization.bindCreation?.(target, operation);
            return authorization.assertCurrent;
          },
          onSessionCreated: authorization.recordCreatedSession,
        }
      : {}),
  });
}
