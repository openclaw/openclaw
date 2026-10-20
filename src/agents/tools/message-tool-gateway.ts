import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { ConversationReadInvocationOrigin } from "../../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withMessageActionInvocationConfig } from "../../gateway/message-action-turn-capability.js";
import type { MessageActionGateway } from "../../infra/outbound/message-action-contracts.js";
import type {
  OutboundGatewayRequest,
  OutboundGatewayRequestContext,
} from "../../infra/outbound/message-gateway-options.js";
import {
  readGatewayCallOptions,
  resolveGatewayOptions,
  resolveMessageActionAgentRuntimeIdentity,
  resolveMessageActionAgentRuntimeIdentityToken,
  shouldUseInProcessGatewayTool,
} from "./gateway.js";
import {
  bindAgentToolGatewayRequest,
  withAgentToolGatewayRuntimeIdentity,
} from "./in-process-gateway.js";

/** Capture message routing before preparation can await or the Gateway can retire. */
export function createMessageToolGateway(
  params: Record<string, unknown>,
  options?: {
    conversationReadOrigin?: ConversationReadInvocationOrigin;
    messageActionTurnCapability?: string;
    agentSessionKey?: string;
    runId?: string;
    sessionId?: string;
  },
  signal?: AbortSignal,
  invocation?: {
    resolveConfig: () => OpenClawConfig;
    preserveWriteOutcome: boolean;
    hasScheduledAuthority: boolean;
  },
): MessageActionGateway | undefined {
  const gatewayOpts = readGatewayCallOptions(params);
  const hasPerCallGatewayConnection = Boolean(
    gatewayOpts.gatewayUrl?.trim() || gatewayOpts.gatewayToken?.trim(),
  );
  const hasScheduledAuthority = invocation?.hasScheduledAuthority === true;
  const resolutionOpts = hasScheduledAuthority
    ? { ...gatewayOpts, gatewayUrl: undefined, gatewayToken: undefined }
    : gatewayOpts;
  if (hasScheduledAuthority) {
    delete params.gatewayUrl;
    delete params.gatewayToken;
  }
  if (options?.conversationReadOrigin === "direct-operator") {
    return undefined;
  }
  const boundRequest =
    !hasPerCallGatewayConnection && shouldUseInProcessGatewayTool(resolutionOpts)
      ? withMessageActionInvocationConfig(
          options?.messageActionTurnCapability,
          invocation?.resolveConfig,
          () =>
            bindAgentToolGatewayRequest({
              revalidateOnCompletion: !invocation?.preserveWriteOutcome,
            }),
        )
      : undefined;
  const { target, ...connection } = resolveGatewayOptions(resolutionOpts);
  const scheduledConnection = hasScheduledAuthority
    ? { ...connection, url: undefined, token: undefined }
    : connection;
  const requireBoundScheduledGateway =
    hasScheduledAuthority && !boundRequest
      ? async <T>(): Promise<T> => {
          throw new Error(
            hasPerCallGatewayConnection
              ? "Scheduled message actions require the active bound Gateway. Remove per-call gatewayUrl and gatewayToken fields and retry."
              : "Scheduled message actions require an active bound Gateway.",
          );
        }
      : undefined;
  const callerOwnsTerminalReceipt =
    !requireBoundScheduledGateway &&
    !boundRequest &&
    (target === "remote" || hasPerCallGatewayConnection);
  const identityParams = {
    opts: resolutionOpts,
    target: boundRequest ? ("local" as const) : target,
    turnCapability: options?.messageActionTurnCapability,
    turnCapabilitySessionKey: options?.agentSessionKey,
    runId: options?.runId,
    sessionId: options?.sessionId,
    callerOwnsTerminalReceipt,
  };
  return {
    ...scheduledConnection,
    clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
    clientDisplayName: "agent",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    ...(callerOwnsTerminalReceipt ? { terminalSourceReplyReceiptOwner: "caller" } : {}),
    ...(requireBoundScheduledGateway
      ? { request: requireBoundScheduledGateway }
      : boundRequest
        ? {
            request: async <T>(
              request: OutboundGatewayRequest,
              context?: OutboundGatewayRequestContext,
            ) => {
              const identity = await resolveMessageActionAgentRuntimeIdentity({
                ...identityParams,
                ...context,
              });
              return boundRequest<T>(
                withAgentToolGatewayRuntimeIdentity(
                  { ...request, signal: request.signal ?? signal },
                  identity,
                ),
              );
            },
          }
        : {
            resolveAgentRuntimeIdentityToken: (context?: OutboundGatewayRequestContext) =>
              resolveMessageActionAgentRuntimeIdentityToken({ ...identityParams, ...context }),
          }),
  };
}
