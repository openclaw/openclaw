import type { OpenClawConfig } from "../../config/config.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";

export function resolveCronAgentSessionKey(params: {
  sessionKey: string;
  agentId: string;
  mainKey?: string | undefined;
}): string {
  return toAgentStoreSessionKey({
    agentId: params.agentId,
    requestKey: params.sessionKey.trim(),
    mainKey: params.mainKey,
  });
}

export function canonicalizeCronSessionKey(params: {
  cfg: Pick<OpenClawConfig, "session">;
  sessionKey: string;
  agentId: string;
}): string {
  const candidate = resolveCronAgentSessionKey({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    mainKey: params.cfg.session?.mainKey,
  });
  return canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: candidate,
  });
}
