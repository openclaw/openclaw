// Base session-key helper keeps outbound-only delivery aligned with route
// resolution session-scope rules.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  buildAgentSessionKey,
  resolveOutboundBindingSessionScope,
  type RoutePeer,
} from "../../routing/resolve-route.js";

/**
 * Builds the canonical outbound base-session key for a resolved route peer.
 *
 * Mirrors the routing layer's session-scope rules so outbound-only sends and
 * inbound route resolution keep the same `dmScope`, `groupScope`, and
 * identity-link behavior. The session scope is resolved from the matching
 * binding's per-binding `session` override (when present) falling back to the
 * global `session` config, so a peer/group with a per-binding override routes
 * to the same session inbound and outbound.
 */
export function buildOutboundBaseSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel: string;
  accountId?: string | null;
  peer: RoutePeer;
}): string {
  const override = resolveOutboundBindingSessionScope(
    params.cfg,
    params.channel,
    params.accountId,
    params.peer,
  );
  return buildAgentSessionKey({
    agentId: params.agentId,
    channel: params.channel,
    accountId: params.accountId,
    peer: params.peer,
    dmScope: override?.dmScope ?? params.cfg.session?.dmScope ?? "main",
    groupScope: override?.groupScope ?? params.cfg.session?.groupScope,
    identityLinks: params.cfg.session?.identityLinks,
  });
}
