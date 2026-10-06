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
  return buildAgentSessionKey({
    agentId: params.agentId,
    mainKey: params.cfg.session?.mainKey,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    dmScope: params.cfg.session?.dmScope ?? "main",
    groupScope: params.cfg.session?.groupScope ?? "per-group",
    identityLinks: params.cfg.session?.identityLinks,
  });
}
