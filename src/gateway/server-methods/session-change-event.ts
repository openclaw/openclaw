// Shared sessions.changed broadcaster for gateway RPC and chat-command mutations.
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { hasSessionChangeReceivers } from "../session-change-receivers.js";
import { buildGatewaySessionEventFields } from "../session-event-payload.js";
import { invalidateSessionSharingSnapshot } from "../session-sharing.js";
import { loadGatewaySessionRow } from "../session-utils.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import type { GatewayRequestContext } from "./types.js";

type SessionChangedPayload = {
  sessionKey?: string;
  agentId?: string;
  reason: string;
  compacted?: boolean;
};

export function emitSessionsChanged(
  context: Pick<
    GatewayRequestContext,
    | "broadcastToConnIds"
    | "chatAbortControllers"
    | "getRuntimeConfig"
    | "getSessionEventSubscriberConnIds"
  >,
  payload: SessionChangedPayload,
) {
  invalidateSessionSharingSnapshot(payload.sessionKey);
  const connIds = context.getSessionEventSubscriberConnIds();
  if (!hasSessionChangeReceivers(connIds)) {
    return;
  }
  const sessionRow = payload.sessionKey
    ? loadGatewaySessionRow(
        payload.sessionKey,
        payload.sessionKey === "global" && payload.agentId
          ? { agentId: payload.agentId }
          : undefined,
      )
    : null;
  const cfg = context.getRuntimeConfig();
  const compatibilityAgentId = tryResolveLegacyCompatibilityAgentId(cfg);
  let defaultAgentId: string | undefined;
  if (sessionRow) {
    try {
      defaultAgentId = resolveAgentIdFromSessionKey(
        sessionRow.key,
        sessionRow.key === "global"
          ? compatibilityAgentId
          : (payload.agentId ?? compatibilityAgentId),
      );
    } catch {
      defaultAgentId = undefined;
    }
  }
  const activeRunState =
    sessionRow &&
    (sessionRow.key !== "global" || defaultAgentId !== undefined || payload.agentId !== undefined)
      ? resolveVisibleActiveSessionRunState({
          context,
          requestedKey: payload.sessionKey ?? sessionRow.key,
          canonicalKey: sessionRow.key,
          sessionId: sessionRow.sessionId,
          agentId: sessionRow.key === "global" ? payload.agentId : undefined,
          defaultAgentId,
        })
      : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...payload,
      ts: Date.now(),
      ...(sessionRow
        ? {
            ...buildGatewaySessionEventFields({
              sessionRow,
              agentId: payload.agentId,
              hasActiveRun: activeRunState?.active,
              activeRunIds: activeRunState?.runIds,
            }),
            effectiveFastMode: sessionRow.effectiveFastMode,
            effectiveFastModeSource: sessionRow.effectiveFastModeSource,
            fastAutoOnSeconds: sessionRow.fastAutoOnSeconds,
            traceLevel: sessionRow.traceLevel,
            pluginExtensions: sessionRow.pluginExtensions,
          }
        : {}),
    },
    connIds,
    {
      ...(payload.agentId ? { agentId: payload.agentId } : {}),
      dropIfSlow: true,
      // Scope only to a concrete key; a `[undefined]` scope filters no connection
      // correctly and would strip draft gating, so fall back to an unscoped send.
      ...(sessionRow?.key ? { sessionKeys: [sessionRow.key] } : {}),
    },
  );
}
