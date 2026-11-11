import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildAgentSessionKey, type RoutePeer } from "../../routing/resolve-route.js";

/** Outbound-only sends use the routing owner's session scopes and identity links. */
export function buildOutboundBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer: RoutePeer;
}): string {
  const { cfg, ...route } = params;
  return buildAgentSessionKey({
    ...route,
    mainKey: cfg.session?.mainKey,
    dmScope: cfg.session?.dmScope ?? "main",
    groupScope: cfg.session?.groupScope ?? "per-group",
    identityLinks: cfg.session?.identityLinks,
  });
}
