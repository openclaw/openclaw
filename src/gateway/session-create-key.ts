import { randomUUID } from "node:crypto";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toAgentStoreSessionKey } from "../routing/session-key.js";

export function buildDashboardSessionKey(
  agentId: string,
  options: { incognito?: boolean } = {},
): string {
  const opaqueId = `${options.incognito ? "incognito-" : ""}${randomUUID()}`;
  return `agent:${agentId}:dashboard:${opaqueId}`;
}

export function resolveSessionCreateTargetKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  requestedKey?: string;
}): string | undefined {
  const { cfg, agentId, requestedKey } = params;
  const loweredRequestedKey = normalizeOptionalLowercaseString(requestedKey);
  return requestedKey
    ? loweredRequestedKey === "global" || loweredRequestedKey === "unknown"
      ? loweredRequestedKey
      : toAgentStoreSessionKey({ agentId, requestKey: requestedKey, mainKey: cfg.session?.mainKey })
    : undefined;
}
