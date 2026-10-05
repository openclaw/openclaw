import { listAgentIds, resolveAmbientOwnerAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveRequestedSessionAgentInput } from "./session-request-agent.js";
import { invalidSessionRequest } from "./session-request-error.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";
import { resolveSessionStoreKey } from "./session-utils.js";

export async function resolveSessionResetTarget(
  cfg: OpenClawConfig,
  params: { key: string; agentId?: string },
) {
  const agentInput = resolveRequestedSessionAgentInput(params.key, params.agentId);
  if (!agentInput.ok) {
    return agentInput;
  }
  const explicitAgentId = agentInput.value;
  const parsedKey = parseAgentSessionKey(params.key);
  const inferredGlobalAgentId =
    !explicitAgentId &&
    parsedKey &&
    resolveSessionStoreKey({ cfg, sessionKey: params.key }) === "global"
      ? normalizeAgentId(parsedKey.agentId)
      : undefined;
  const requestedAgentId = explicitAgentId ?? inferredGlobalAgentId;
  if (requestedAgentId && !listAgentIds(cfg).includes(requestedAgentId)) {
    return invalidSessionRequest(`Unknown agent id: ${requestedAgentId}`);
  }
  if (
    explicitAgentId &&
    parsedKey?.agentId &&
    normalizeAgentId(parsedKey.agentId) !== explicitAgentId
  ) {
    return invalidSessionRequest("session key agent does not match agentId");
  }
  const target = await resolveGatewaySessionStoreTargetInWorker({
    cfg,
    key: params.key,
    ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
  });
  return { ok: true as const, cfg, target, storePath: target.storePath, requestedAgentId };
}

export function resolveLifecycleAgentId(cfg: OpenClawConfig, agentId?: string): string {
  return normalizeAgentId(agentId ?? resolveAmbientOwnerAgentId(cfg));
}
