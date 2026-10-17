import { randomUUID } from "node:crypto";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  type UiCommandParams,
  type UiCommandResult,
  type UiPortalPresentation,
  validateUiCommandParams,
  validateUiCommandReportParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayPersonalToolParticipant,
} from "../../agents/tools/gateway-caller-context.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import { captureGatewayUiCommandTarget } from "../ui-command-target.js";
import { assertActiveAgentRuntimeAuthority } from "./agent-runtime-authority.js";
import type {
  GatewayClient,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

const PRESENTATION_TIMEOUT_MS = 8_000;
type PendingPresentation = {
  recipient: GatewayClient;
  portalId?: string;
  finish: (presentation: UiPortalPresentation) => void;
};
// Only in-flight observations are retained; never reuse another browser’s result.
const presentations = new Map<string, PendingPresentation>();

function waitForPresentation(
  requestId: string,
  recipient: GatewayClient,
  portalId?: string,
): Promise<UiPortalPresentation> {
  return new Promise((resolve) => {
    const finish = (presentation: UiPortalPresentation) => {
      clearTimeout(timer);
      recipient.connectionSignal?.removeEventListener("abort", disconnected);
      presentations.delete(requestId);
      resolve(presentation);
    };
    const unverified = (reason: "client-timeout" | "client-disconnected") =>
      finish({
        ...(portalId ? { portalId } : {}),
        status: "unverified",
        reason,
      });
    const disconnected = () => unverified("client-disconnected");
    const timer = setTimeout(() => unverified("client-timeout"), PRESENTATION_TIMEOUT_MS);
    presentations.set(requestId, { recipient, portalId, finish });
    recipient.connectionSignal?.addEventListener("abort", disconnected, { once: true });
  });
}

export function dispatchUiCommandToRequester({
  params: commandParams,
  context,
  client,
  beforeDispatch,
}: Pick<GatewayRequestHandlerOptions, "context" | "client"> & {
  params: UiCommandParams;
  beforeDispatch?: (recipient: GatewayClient) => void;
}): { ok: true } | { ok: false; error: ReturnType<typeof errorShape> } {
  const runtimeIdentity = client?.internal?.agentRuntimeIdentity;
  const participant = resolveGatewayPersonalToolParticipant(runtimeIdentity);
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
    return { ok: false, error: requestedSession.error };
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
  const target = participant
    ? participant.gatewayUiCommandTarget
    : runtimeIdentity
      ? runtimeIdentity.gatewayUiCommandTarget
      : (getGatewayToolCallerIdentity()?.gatewayUiCommandTarget ??
        captureGatewayUiCommandTarget(client));
  // A session identifies what to open, never whose browser to move.
  let selectedRecipient: GatewayClient | undefined;
  const connIds =
    context.getClientConnIds?.((recipient) => {
      const selected =
        target !== undefined &&
        recipient.connId === target.connId &&
        !recipient.invalidated &&
        !recipient.connectionSignal?.aborted &&
        (!target.profileId || recipient.authenticatedUserProfile?.profileId === target.profileId) &&
        recipient.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI &&
        hasGatewayClientCap(recipient.connect.caps, GATEWAY_CLIENT_CAPS.UI_COMMANDS);
      if (selected) {
        selectedRecipient = recipient;
      }
      return selected;
    }) ?? new Set<string>();
  if (connIds.size === 0) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        target
          ? "requesting Control UI is no longer connected; ask again from the open Control UI"
          : "no requesting Control UI; ask from the Control UI to change its view",
      ),
    };
  }

  participant?.assertCurrent();
  if (selectedRecipient) {
    beforeDispatch?.(selectedRecipient);
  }
  context.broadcastToConnIds("ui.command", normalizedParams, connIds);
  return { ok: true };
}

export const uiCommandHandlers: GatewayRequestHandlers = {
  "ui.command.result": defineValidatedGatewayMethod(
    "ui.command.result",
    validateUiCommandReportParams,
    ({ params, client, respond }) => {
      const pending = presentations.get(params.requestId);
      if (
        !pending ||
        client?.connect.client.id !== GATEWAY_CLIENT_IDS.CONTROL_UI ||
        client.connId !== pending.recipient.connId ||
        pending.recipient.invalidated ||
        pending.recipient.connectionSignal?.aborted ||
        client.invalidated ||
        client.connectionSignal?.aborted ||
        (pending.portalId && params.presentation.portalId !== pending.portalId)
      ) {
        respond(true, { ok: false });
        return;
      }
      pending.finish(params.presentation);
      respond(true, { ok: true });
    },
  ),
  "ui.command": defineValidatedGatewayMethod(
    "ui.command",
    validateUiCommandParams,
    async (options) => {
      assertActiveAgentRuntimeAuthority(options.client, options.context);
      const command = options.params.command;
      const requestId =
        command.kind === "panel" && command.panel === "portal" && command.open
          ? randomUUID()
          : undefined;
      let observation: Promise<UiPortalPresentation> | undefined;
      const result = dispatchUiCommandToRequester({
        ...options,
        // Correlation is assigned here, never accepted from a caller.
        params: {
          command,
          ...(options.params.sessionKey ? { sessionKey: options.params.sessionKey } : {}),
          ...(options.params.agentId ? { agentId: options.params.agentId } : {}),
          ...(requestId ? { requestId } : {}),
        },
        beforeDispatch: requestId
          ? (recipient) => {
              observation = waitForPresentation(
                requestId,
                recipient,
                "portalId" in command ? command.portalId : undefined,
              );
            }
          : undefined,
      });
      if (result.ok) {
        const presentation = observation ? await observation : undefined;
        assertActiveAgentRuntimeAuthority(options.client, options.context);
        resolveGatewayPersonalToolParticipant(
          options.client?.internal?.agentRuntimeIdentity,
        )?.assertCurrent();
        // Portal feedback is additive; unrelated UI commands retain their response contract.
        const reply: UiCommandResult = {
          ok: true,
          ...(presentation ? { delivery: "dispatched", presentation } : {}),
        };
        options.respond(true, reply);
      } else {
        options.respond(false, undefined, result.error);
      }
    },
    (error) =>
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        error instanceof Error ? error.message : String(error),
      ),
  ),
};
