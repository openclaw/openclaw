import { getControllerEmbeddedAttachment } from "../../agents/embedded-agent-runner/run-state.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { getGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  getRpcSourceForGateway,
  isRpcSourceRegistered,
  listRpcSourceEntriesForTarget,
  type RpcSourceRef,
} from "../../sessions/session-controller.rpc-sources.js";
import {
  getAttachedBackend,
  isCurrentSessionControllerOperation,
} from "../../sessions/session-controller.state.js";
import type { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { resolveClientVoiceRunBinding } from "../../talk/client-voice-session.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

/** Validate consult control or completion against its captured source identity. */
export function isTalkConsultSourceCurrent(params: {
  entry?: RpcSourceRef;
  connectionId: string;
  sessionId: string;
  sessionKey: string;
  lifecycleGeneration?: string;
  phase: "active" | "completion";
}): boolean {
  const { entry, lifecycleGeneration } = params;
  if (!entry || entry.input.abortSignal.aborted || !lifecycleGeneration) {
    return false;
  }
  if (
    params.phase === "active" &&
    (entry.input.retirementRequested || entry.input.phase === "consumed")
  ) {
    return false;
  }
  // Clean settlement retains completion custody, never active steering authority.
  if (
    !isRpcSourceRegistered(entry) &&
    !(
      params.phase === "completion" &&
      entry.input.phase === "consumed" &&
      entry.input.custody.failure === undefined &&
      entry.input.protocolRunId !== undefined &&
      !getRpcSourceForGateway(entry.input.protocolRunId, getGatewayContextResolver(entry.input))
    )
  ) {
    return false;
  }
  const identity = getRpcSourceIdentity(entry);
  return (
    entry.adapter.requester?.connectionId === params.connectionId &&
    identity.sessionId === params.sessionId &&
    identity.sessionKey === params.sessionKey &&
    getRpcSourceLifecycleGeneration(entry) === lifecycleGeneration &&
    isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
  );
}

export function resolveOwnedActiveTalkRunTarget(params: {
  clientConnId?: string;
  sessionTarget: PreparedTalkSessionTarget;
  /** The shipped talk.client.steer RPC is session-wide; attached transports select their call. */
  scope: { kind: "session" } | { kind: "voice-session"; voiceSessionId: string };
  assertCurrent?: () => void;
}):
  | (NonNullable<Parameters<typeof controlRealtimeVoiceAgentRun>[0]["runTarget"]> & {
      toolAuthoritySource?: "reply" | "attempt";
    })
  | null {
  const connId = params.clientConnId;
  if (!connId) {
    return null;
  }
  const { agentId, sessionKey, canonicalKey } = params.sessionTarget;
  const target = captureSessionTarget({
    storeScope: params.sessionTarget.storePath,
    sessionKey: canonicalKey,
    agentId,
  });
  for (const [runId, entry] of listRpcSourceEntriesForTarget(target)) {
    const generation = getRpcSourceLifecycleGeneration(entry);
    if (!generation) {
      continue;
    }
    const signal = entry.input.abortSignal;
    const claim = entry.input.claim;
    const operation = claim?.operation;
    if (!claim || claim.released || !operation || !isCurrentSessionControllerOperation(operation)) {
      continue;
    }
    const registration = getControllerEmbeddedAttachment(operation);
    const handle = registration?.handle;
    const voiceBinding =
      params.scope.kind === "voice-session" ? resolveClientVoiceRunBinding(runId) : undefined;
    // Session RPCs can own a queued reply before its backend exists. Attached
    // voice controls instead preserve captured backend absence across their FIFO.
    const reply = params.scope.kind === "session" && !handle ? operation : undefined;
    const isCurrent = (resolvedSessionId?: string) => {
      params.assertCurrent?.();
      const currentIdentity = getRpcSourceIdentity(entry);
      const replyOwner =
        reply &&
        entry.input.claim === claim &&
        claim.operation === reply &&
        isCurrentSessionControllerOperation(reply)
          ? reply
          : undefined;
      const replyAttachment = replyOwner ? getControllerEmbeddedAttachment(replyOwner) : undefined;
      if (params.scope.kind === "voice-session") {
        // Retain the claim instance: A-to-B-to-A is reassignment, not revival.
        // Identical registrations preserve this snapshot at the producer.
        if (
          !voiceBinding ||
          resolveClientVoiceRunBinding(runId) !== voiceBinding ||
          voiceBinding.voiceSessionId !== params.scope.voiceSessionId ||
          voiceBinding.agentId !== agentId ||
          voiceBinding.sessionKey !== sessionKey
        ) {
          return false;
        }
      }
      return (
        isRpcSourceRegistered(entry) &&
        entry.input.claim === claim &&
        claim.operation === operation &&
        !claim.released &&
        isCurrentSessionControllerOperation(operation) &&
        !operation.abortSignal.aborted &&
        !operation.result &&
        currentIdentity.agentId === agentId &&
        (currentIdentity.sessionKey === sessionKey ||
          currentIdentity.sessionKey === canonicalKey) &&
        entry.adapter.requester?.connectionId === connId &&
        entry.adapter.kind !== "agent" &&
        (!reply ||
          (replyOwner?.key === canonicalKey &&
            (!replyAttachment || getAttachedBackend(reply) === replyAttachment.backend?.handle))) &&
        (resolvedSessionId === undefined ||
          (currentIdentity.sessionId === resolvedSessionId &&
            (replyOwner
              ? replyOwner.sessionId === resolvedSessionId
              : handle !== undefined &&
                getControllerEmbeddedAttachment(operation) === registration))) &&
        entry.input.abortSignal === signal &&
        !signal.aborted &&
        getRpcSourceLifecycleGeneration(entry) === generation &&
        isAgentEventLifecycleGenerationCurrent(generation)
      );
    };
    if (isCurrent()) {
      const toolAuthoritySource = reply ? "reply" : registration?.toolAuthority?.source;
      return { runId, signal, isCurrent, toolAuthoritySource };
    }
  }
  return null;
}
