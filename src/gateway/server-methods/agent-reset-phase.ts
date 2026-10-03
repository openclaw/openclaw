import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  missingScopeErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { assertPreparedSkillLibrarySelection } from "../../skills/library/selection.js";
import { AGENT_SESSION_RESET_COMMAND_RE } from "../agent-command-policy.js";
import { setGatewayDedupeEntries } from "../agent-turn/agent-dedupe.js";
import { ADMIN_SCOPE, hasGatewayAdminScope } from "../operator-scopes.js";
import { performGatewaySessionReset } from "../session-reset-service.js";
import { prepareSkillLibrarySessionCreation } from "../skill-library-session.js";
import { formatForLog } from "../ws-log.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import {
  buildBareSessionResetResponse,
  loadBareSessionResetDeliverySession,
  resolveBareSessionResetResult,
} from "./agent-session-reset.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { resolveAgentRunSessionCreation } from "./session-creation-provenance.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type CommittedResetCompletion = {
  reason: "new" | "reset";
  sessionId?: string;
  sessionKey: string;
  agentId?: string;
  followUpPending: boolean;
  replyError?: ErrorShape;
};

type AgentResetPhaseResult = {
  stop: boolean;
  accepted: boolean;
  requestedSessionKey?: string;
  resolvedSessionId?: string;
  effectiveTranscriptInputText: string;
  message: string;
};

export async function runAgentResetPhase(params: {
  assertAdmissionCurrent?: () => void;
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  requestedSessionKey?: string;
  resolvedSessionId?: string;
  effectiveTranscriptInputText: string;
  message: string;
  agentId?: string;
  sessionKeyFromTo?: string;
  lifecycleGeneration: string;
  runId: string;
  agentDedupeKeys: readonly string[];
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  respond: GatewayRequestHandlerOptions["respond"];
  abortForLifecycleRotation: (target?: { sessionKey?: string; agentId?: string }) => boolean;
  setCommittedResetCompletion: (completion: CommittedResetCompletion) => void;
}): Promise<AgentResetPhaseResult> {
  const base = {
    requestedSessionKey: params.requestedSessionKey,
    resolvedSessionId: params.resolvedSessionId,
    effectiveTranscriptInputText: params.effectiveTranscriptInputText,
    message: params.message,
  };
  const resetCommandMatch = params.message.match(AGENT_SESSION_RESET_COMMAND_RE);
  if (!resetCommandMatch || !params.requestedSessionKey) {
    return { ...base, stop: false, accepted: false };
  }
  if (
    params.abortForLifecycleRotation({
      sessionKey: params.requestedSessionKey,
      agentId: params.agentId,
    })
  ) {
    return { ...base, stop: true, accepted: true };
  }
  const postResetMessage = normalizeOptionalString(resetCommandMatch[2]) ?? "";
  if (!hasGatewayAdminScope(params.client)) {
    params.respond(
      false,
      undefined,
      missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
    );
    return { ...base, stop: true, accepted: false };
  }
  const resetReason =
    normalizeOptionalLowercaseString(resetCommandMatch[1]) === "new" ? "new" : "reset";
  params.assertAdmissionCurrent?.();
  let resetResult: Awaited<ReturnType<typeof performGatewaySessionReset>>;
  try {
    const creation = await prepareSkillLibrarySessionCreation(
      params.client,
      params.context.getRuntimeConfig,
      resolveAgentRunSessionCreation(params.client),
    );
    resetResult = await performGatewaySessionReset({
      key: params.requestedSessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      reason: resetReason,
      commandSource: "gateway:agent",
      armSessionDiffBaselineCapture: true,
      creation,
      ...(params.client?.authenticatedUserProfile?.profileId
        ? { requestingOperatorProfileId: params.client.authenticatedUserProfile.profileId }
        : {}),
      ...(params.client?.internal?.operatorRoleActor
        ? { operatorRoleActor: params.client.internal.operatorRoleActor }
        : {}),
      assertCurrent: () => {
        params.assertAdmissionCurrent?.();
        assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
        assertPreparedSkillLibrarySelection(creation.skillLibrarySelections);
      },
      onCommitted: (commit) => {
        params.setCommittedResetCompletion({
          reason: resetReason,
          sessionId: commit.sessionId,
          sessionKey: commit.key,
          agentId: params.agentId,
          followUpPending: Boolean(postResetMessage),
        });
      },
    });
  } catch (err) {
    if (
      params.abortForLifecycleRotation({
        sessionKey: params.requestedSessionKey,
        agentId: params.agentId,
      })
    ) {
      return { ...base, stop: true, accepted: true };
    }
    throw err;
  }
  if (!resetResult.ok) {
    params.respond(false, undefined, resetResult.error);
    return { ...base, stop: true, accepted: false };
  }
  const resetSessionId =
    "incognitoDeleted" in resetResult ? undefined : resetResult.entry.sessionId;
  const next = {
    ...base,
    requestedSessionKey: resetResult.key,
    resolvedSessionId: resetSessionId ?? params.resolvedSessionId,
  };
  const completion: CommittedResetCompletion = {
    reason: resetReason,
    sessionId: resetSessionId,
    sessionKey: resetResult.key,
    agentId: params.agentId,
    followUpPending: Boolean(postResetMessage),
  };
  params.setCommittedResetCompletion(completion);
  params.assertAdmissionCurrent?.();
  if (postResetMessage) {
    if (
      params.abortForLifecycleRotation({ sessionKey: resetResult.key, agentId: params.agentId })
    ) {
      return { ...next, stop: true, accepted: true };
    }
    return {
      ...next,
      stop: false,
      accepted: false,
      effectiveTranscriptInputText: postResetMessage,
      message: postResetMessage,
    };
  }

  try {
    const deliverySession =
      params.request.deliver === true
        ? loadBareSessionResetDeliverySession({
            sessionKey: resetResult.key,
            ...(params.agentId ? { agentId: params.agentId } : {}),
          })
        : undefined;
    const resetAckResult = await resolveBareSessionResetResult({
      cfg: deliverySession?.cfg ?? params.cfg,
      context: params.context,
      reason: resetReason,
      sessionId: resetSessionId,
      sessionKey: resetResult.key,
      agentId: deliverySession?.agentId ?? params.agentId,
      sessionEntry: deliverySession?.entry,
      request: params.sessionKeyFromTo ? { ...params.request, to: undefined } : params.request,
      runId: params.runId,
      assertCurrent: () => {
        params.assertAdmissionCurrent?.();
        assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
      },
    });
    params.assertAdmissionCurrent?.();
    const responsePayload = buildBareSessionResetResponse({
      runId: params.runId,
      result: resetAckResult,
    });
    setGatewayDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
      entry: { ts: Date.now(), ok: true, payload: responsePayload },
    });
    params.respond(true, responsePayload, undefined, { runId: params.runId });
    emitSessionsChanged(params.context, {
      sessionKey: resetResult.key,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      reason: resetReason,
    });
    return { ...next, stop: true, accepted: true };
  } catch (err) {
    const error = errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err));
    // The reset committed, but its requested reply failed. Cleanup and restart
    // replay must retain that outcome without repeating either side effect.
    if (params.request.deliver === true) {
      params.setCommittedResetCompletion({ ...completion, replyError: error });
    }
    if (
      params.abortForLifecycleRotation({ sessionKey: resetResult.key, agentId: params.agentId })
    ) {
      return { ...next, stop: true, accepted: true };
    }
    params.respond(false, undefined, error);
    return { ...next, stop: true, accepted: false };
  }
}
