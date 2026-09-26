import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type MessageActionParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  isFencedProviderReadAction,
  isScheduledMessageWriteAction,
} from "../../channels/plugins/message-action-dispatch.js";
import type { InternalChannelThreadingToolContext } from "../../channels/threading-tool-context-internal.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  normalizeSessionKeyPreservingOpaquePeerIds,
  parseAgentSessionKey,
} from "../../sessions/session-key-utils.js";
import {
  readMessageActionInvocationConfig,
  resolveMessageActionTurnAuthorization,
  selectMessageActionRequesterIdentity,
  type MessageActionAuthorization,
} from "../message-action-turn-capability.js";
import { createAgentRuntimeAuthorityGuard } from "./agent-runtime-authority.js";
import type { GatewayClient, GatewayRequestHandlers } from "./types.js";

/** Redeem host-only message authority from a trusted local agent runtime. */
export function resolveAgentRuntimeMessageActionAuthorization(
  client: GatewayClient | null,
): MessageActionAuthorization | undefined {
  const identity = client?.internal?.agentRuntimeIdentity;
  const messageActionContext = identity?.messageActionContext;
  return identity && messageActionContext?.turnCapability
    ? resolveMessageActionTurnAuthorization({
        token: messageActionContext.turnCapability,
        agentId: identity.agentId,
        runId: identity.operationalRunInstance.runId,
        sessionKey: identity.sessionKey,
        sessionId: messageActionContext.sessionId,
      })
    : undefined;
}

/** Resolve the admitted config only while the matching bound action is dispatched. */
export function resolveAgentRuntimeMessageActionConfig(
  client: GatewayClient | null,
): OpenClawConfig | undefined {
  const token = client?.internal?.agentRuntimeIdentity?.messageActionContext?.turnCapability;
  return resolveAgentRuntimeMessageActionAuthorization(client)?.scheduled
    ? readMessageActionInvocationConfig(token)
    : undefined;
}

/** Retain the live caller and scheduled source through this action's requests. */
export function createMessageActionRuntimeAuthority(
  params: Pick<
    Parameters<GatewayRequestHandlers["message.action"]>[0],
    "client" | "context" | "respond" | "sessionMutationCommitGuard"
  > & {
    request: Pick<MessageActionParams, "action" | "accountId" | "params">;
    authorization?: MessageActionAuthorization;
  },
) {
  const assertScheduledSourceCurrent =
    params.authorization?.scheduled?.assertSourceCurrent ??
    params.authorization?.scheduled?.assertCurrent;
  const assertReadCurrent = isFencedProviderReadAction(params.request.action)
    ? (assertScheduledSourceCurrent ?? params.authorization?.assertDashboardReadCurrent)
    : undefined;
  const assertScheduledWriteCurrent = isScheduledMessageWriteAction(params.request.action)
    ? assertScheduledSourceCurrent
    : undefined;
  const assertActionCurrent =
    assertReadCurrent ??
    assertScheduledWriteCurrent ??
    params.authorization?.scheduled?.assertCurrent;
  const scheduledPolicy =
    assertReadCurrent || assertScheduledWriteCurrent
      ? params.authorization?.scheduled?.policy
      : undefined;
  return {
    assertReadCurrent,
    assertScheduledWriteCurrent,
    routeAccountId:
      normalizeOptionalString(params.request.accountId) ??
      normalizeOptionalString(params.request.params.accountId) ??
      (scheduledPolicy?.mode === "account" ? scheduledPolicy.ownerAccountId : undefined),
    agentRuntimeAuthority: createAgentRuntimeAuthorityGuard(
      params.client,
      params.context,
      params.respond,
      assertActionCurrent
        ? () => {
            params.sessionMutationCommitGuard?.();
            assertActionCurrent();
          }
        : params.sessionMutationCommitGuard,
    ),
  };
}

export function resolveTrustedMessageActionToolContext(params: {
  client: Parameters<GatewayRequestHandlers["message.action"]>[0]["client"];
  request: {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    allowNativeChannelNamespace?: boolean;
  };
}):
  | ({
      ok: true;
      toolContext: InternalChannelThreadingToolContext | undefined;
      sessionId: string | undefined;
      sourceReplySessionKey: string | undefined;
      sourceReplyFinal: boolean | undefined;
      sourceReplyToolCallId: string | undefined;
      runtimeAgentId: string | undefined;
      messageActionAuthorization?: MessageActionAuthorization;
      messageActionConfig?: OpenClawConfig;
    } & ReturnType<typeof selectMessageActionRequesterIdentity>)
  | { ok: false; error: ReturnType<typeof errorShape> } {
  // Current-turn metadata can relax channel read policy. It must come from the
  // signed host-issued turn context, never from message.action request fields.
  const identity = params.client?.internal?.agentRuntimeIdentity;
  const messageActionContext = identity?.messageActionContext;
  if (!identity || !messageActionContext) {
    return {
      ok: true,
      toolContext: undefined,
      ...selectMessageActionRequesterIdentity(undefined),
      sessionId: undefined,
      sourceReplySessionKey: undefined,
      sourceReplyFinal: undefined,
      sourceReplyToolCallId: undefined,
      runtimeAgentId: undefined,
    };
  }
  if (Date.now() >= messageActionContext.expiresAtMs) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "message.action agent runtime context has expired",
      ),
    };
  }
  const requestSessionKey = normalizeSessionKeyPreservingOpaquePeerIds(params.request.sessionKey);
  const identitySessionKey = normalizeSessionKeyPreservingOpaquePeerIds(identity.sessionKey);
  const identityAgentId = normalizeAgentId(identity.agentId);
  const requestAgentId = normalizeOptionalString(params.request.agentId);
  const sessionAgentId = parseAgentSessionKey(requestSessionKey)?.agentId;
  const requestSessionId = normalizeOptionalString(params.request.sessionId);
  const sourceReplySessionKey =
    normalizeSessionKeyPreservingOpaquePeerIds(messageActionContext.sourceReplySessionKey) ||
    undefined;
  const sourceReplySessionAgentId = parseAgentSessionKey(sourceReplySessionKey)?.agentId;
  if (
    !requestSessionKey ||
    requestSessionKey !== identitySessionKey ||
    (requestAgentId && normalizeAgentId(requestAgentId) !== identityAgentId) ||
    (sessionAgentId && normalizeAgentId(sessionAgentId) !== identityAgentId) ||
    (messageActionContext.sessionId && requestSessionId !== messageActionContext.sessionId) ||
    (sourceReplySessionKey &&
      sourceReplySessionAgentId &&
      normalizeAgentId(sourceReplySessionAgentId) !== identityAgentId)
  ) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "message.action agent runtime identity does not match the requested session",
      ),
    };
  }
  const redeemedAuthorization = resolveAgentRuntimeMessageActionAuthorization(params.client);
  const messageActionAuthorization = redeemedAuthorization
    ? {
        ...redeemedAuthorization,
        allowNativeChannelNamespace: redeemedAuthorization.scheduled
          ? (params.request.allowNativeChannelNamespace ?? true)
          : undefined,
      }
    : undefined;
  return {
    ok: true,
    toolContext: messageActionContext.toolContext,
    ...selectMessageActionRequesterIdentity(messageActionContext),
    sessionId: messageActionContext.sessionId,
    sourceReplySessionKey,
    sourceReplyFinal: messageActionContext.sourceReplyFinal,
    sourceReplyToolCallId: messageActionContext.sourceReplyToolCallId,
    runtimeAgentId: identityAgentId,
    messageActionAuthorization,
    messageActionConfig: messageActionAuthorization?.scheduled
      ? readMessageActionInvocationConfig(messageActionContext.turnCapability)
      : undefined,
  };
}
