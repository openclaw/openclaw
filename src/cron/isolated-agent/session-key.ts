import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { SessionScope } from "../../config/sessions/types.js";
import { resolveSessionRoute } from "../../routing/resolve-route.js";

export function resolveCronAgentSessionKey(params: {
  sessionKey: string;
  agentId: string;
  mainKey?: string | undefined;
  cfg?: { session?: { scope?: SessionScope; mainKey?: string } };
}): string {
  const resolved = resolveSessionRoute({
    cfg: params.cfg ?? {},
    agentId: params.agentId,
    surface: "cron",
    rawSessionInput: params.sessionKey.trim(),
    sessionScope: "agent",
    mainKey: params.mainKey,
  });
  const fallbackMainSessionKey = resolveAgentMainSessionKey({
    cfg: params.cfg ?? {},
    agentId: params.agentId,
  });
  if (resolved.sessionKey === "global") {
    return fallbackMainSessionKey;
  }
  return resolved.sessionKey;
}
