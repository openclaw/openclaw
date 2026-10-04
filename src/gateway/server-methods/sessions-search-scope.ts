import type { SessionsSearchParams } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../agents/agent-scope-config.js";
import { isConfiguredSessionStoreAgentId } from "../../config/sessions.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentIdStrict, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { invalidSessionRequest } from "../session-request-error.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "../session-store-key.js";

export function resolveSessionSearchScope(cfg: OpenClawConfig, params: SessionsSearchParams) {
  const normalizedRequest =
    params.agentId === undefined ? null : normalizeAgentIdStrict(params.agentId);
  if (normalizedRequest && !normalizedRequest.ok) {
    return invalidSessionRequest(`Unknown agent id "${params.agentId}"`);
  }
  const requestedAgentId = normalizedRequest?.value;
  const sessionKeys: string[] | undefined = params.sessionKeys ? [] : undefined;
  const agentIds = new Set<string>();
  const rosterAgentIds = new Set(listAgentIds(cfg));
  for (const sessionKey of params.sessionKeys ?? []) {
    const parsedKey = parseAgentSessionKey(sessionKey);
    const storeOwnerAgentId = parsedKey ? resolveSessionStoreAgentId(cfg, sessionKey) : undefined;
    const storedSessionKey =
      parsedKey && requestedAgentId
        ? resolveStoredSessionKeyForAgentStore({
            cfg,
            agentId: requestedAgentId,
            sessionKey,
          })
        : undefined;
    const configuredAcpOwner = Boolean(
      requestedAgentId &&
      !rosterAgentIds.has(requestedAgentId) &&
      isConfiguredSessionStoreAgentId(cfg, requestedAgentId) &&
      storeOwnerAgentId === requestedAgentId &&
      parsedKey.rest !== "main" &&
      storedSessionKey &&
      storedSessionKey !== "global" &&
      storedSessionKey !== "unknown" &&
      resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey).kind === "none",
    );
    const requestedAgent =
      requestedAgentId && configuredAcpOwner
        ? ({ ok: true, agentId: requestedAgentId } as const)
        : requestedAgentId &&
            !isConfiguredSessionStoreAgentId(cfg, requestedAgentId) &&
            resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey).kind === "none"
          ? ({ ok: true, agentId: requestedAgentId } as const)
          : resolveRequestedSessionAgentId(cfg, sessionKey, requestedAgentId);
    if (!requestedAgent.ok) {
      return requestedAgent;
    }
    sessionKeys?.push(
      resolveStoredSessionKeyForAgentStore({
        cfg,
        agentId: requestedAgent.agentId,
        sessionKey,
      }),
    );
    agentIds.add(requestedAgent.agentId);
  }
  if (
    agentIds.size > 1 ||
    (requestedAgentId && [...agentIds].some((agentId) => agentId !== requestedAgentId))
  ) {
    return invalidSessionRequest("sessions.search supports one agent per call");
  }
  let agentId = requestedAgentId ?? agentIds.values().next().value;
  if (!agentId) {
    const fallbackAgent = resolveRequestedSessionAgentId(cfg, "main");
    if (!fallbackAgent.ok) {
      return fallbackAgent;
    }
    agentId = fallbackAgent.agentId;
  }
  return {
    ok: true as const,
    agentId,
    configured: isConfiguredSessionStoreAgentId(cfg, agentId),
    requestedAgentId,
    sessionKeys,
  };
}
