import { validateSystemAgentChatHistoryParams } from "../../../packages/gateway-protocol/src/index.js";
import { resolveSystemAgentDelegationKey } from "../../system-agent/delegation-session.js";
import { readTranscriptTail } from "../../system-agent/transcript-store.js";
import { getSystemAgentSessionQueue } from "./system-agent-session-queue.js";
import type { GatewayClient, GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

const DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT = 100;

export function resolveSystemAgentSessionOwnerKey(params: {
  delegation?: { agentId?: string; sessionKey?: string };
  client: GatewayClient | null;
}): string | undefined {
  const delegationKey = resolveSystemAgentDelegationKey(params.delegation);
  if (delegationKey !== undefined) {
    // Delegation is the host-only, cross-connection owner asserted by the regular-agent
    // tool path. Keep its agent/session tuple authoritative across gateway reconnects.
    return delegationKey;
  }
  // Authenticated users survive reconnects and may span paired devices. Otherwise
  // bind to the verified device, with the server-issued connection as a last resort.
  const userId = params.client?.authenticatedUserId?.trim();
  if (userId) {
    return `user:${userId}`;
  }
  const deviceId = params.client?.connect.device?.id.trim();
  if (deviceId) {
    return `device:${deviceId}`;
  }
  const connId = params.client?.connId?.trim();
  return connId ? `connection:${connId}` : undefined;
}

export const systemAgentChatHistoryHandler: GatewayRequestHandler = async ({
  params,
  respond,
  client,
  context,
}) => {
  if (
    !assertValidParams(
      params,
      validateSystemAgentChatHistoryParams,
      "openclaw.chat.history",
      respond,
    )
  ) {
    return;
  }
  const requestedSessionId = params.sessionId;
  const session = requestedSessionId
    ? context.systemAgentSessions.get(requestedSessionId)
    : undefined;
  const ownerKey = resolveSystemAgentSessionOwnerKey({ client });
  const recovery =
    requestedSessionId && session && ownerKey === session.ownerKey
      ? await getSystemAgentSessionQueue(context.systemAgentSessions).enqueue(
          requestedSessionId,
          async () => {
            if (context.systemAgentSessions.get(requestedSessionId) !== session) {
              return undefined;
            }
            session.lastUsedAt = Date.now();
            return {
              turns: readTranscriptTail(params.limit ?? DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT),
              step: await session.engine.activeWizardStep(),
            };
          },
        )
      : undefined;
  const turns =
    recovery?.turns ?? readTranscriptTail(params.limit ?? DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT);
  respond(
    true,
    {
      turns,
      ...(requestedSessionId && recovery?.step
        ? { activeWizard: { sessionId: requestedSessionId, step: recovery.step } }
        : {}),
    },
    undefined,
  );
};
