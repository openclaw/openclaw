import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  type UiCommandParams,
  validateUiCommandParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { captureGatewayUiCommandTarget } from "../ui-command-target.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const uiCommandHandlers: GatewayRequestHandlers = {
  "ui.command": defineValidatedGatewayMethod(
    "ui.command",
    validateUiCommandParams,
    ({ params: commandParams, respond, context, client }) => {
      const commandSessionKey =
        "sessionKey" in commandParams.command
          ? commandParams.command.sessionKey
          : commandParams.sessionKey;
      const requestedSession = commandSessionKey
        ? resolveRequestedSessionAgentId(
            context.getRuntimeConfig(),
            commandSessionKey,
            commandParams.agentId,
          )
        : undefined;
      if (requestedSession && !requestedSession.ok) {
        respond(false, undefined, requestedSession.error);
        return;
      }
      const canonicalSessionKey =
        commandSessionKey && requestedSession?.ok
          ? resolveStoredSessionKeyForAgentStore({
              cfg: context.getRuntimeConfig(),
              agentId: requestedSession.agentId,
              sessionKey: commandSessionKey,
            })
          : undefined;
      const normalizedParams: UiCommandParams = {
        ...commandParams,
        ...(canonicalSessionKey ? { sessionKey: canonicalSessionKey } : {}),
        ...(requestedSession?.ok ? { agentId: requestedSession.agentId } : {}),
        command:
          canonicalSessionKey && "sessionKey" in commandParams.command
            ? { ...commandParams.command, sessionKey: canonicalSessionKey }
            : commandParams.command,
      };
      const runtimeIdentity = client?.internal?.agentRuntimeIdentity;
      const target = runtimeIdentity
        ? runtimeIdentity.gatewayUiCommandTarget
        : (getGatewayToolCallerIdentity()?.gatewayUiCommandTarget ??
          captureGatewayUiCommandTarget(client));
      // A session identifies what to open, never whose browser to move.
      const connIds =
        context.getClientConnIds?.(
          (recipient) =>
            target !== undefined &&
            recipient.connId === target.connId &&
            !recipient.invalidated &&
            !recipient.connectionSignal?.aborted &&
            (!target.profileId ||
              recipient.authenticatedUserProfile?.profileId === target.profileId) &&
            recipient.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI &&
            hasGatewayClientCap(recipient.connect.caps, GATEWAY_CLIENT_CAPS.UI_COMMANDS),
        ) ?? new Set<string>();
      if (connIds.size === 0) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            target
              ? "requesting Control UI is no longer connected; ask again from the open Control UI"
              : "no requesting Control UI; ask from the Control UI to change its view",
          ),
        );
        return;
      }

      context.broadcastToConnIds("ui.command", normalizedParams, connIds);
      respond(true, { ok: true });
    },
  ),
};
