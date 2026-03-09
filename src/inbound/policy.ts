import type { OpenClawConfig } from "../config/config.js";
import { resolveWhatsAppAccount } from "../web/accounts.js";
import {
  DEFAULT_INBOUND_ROUTE_POLICY,
  type InboundPauseMode,
  type InboundRoutePolicy,
} from "./policy-types.js";

function resolvePauseMode(mode?: string): InboundPauseMode {
  if (mode === "paused_silent" || mode === "paused_autoreply") {
    return mode;
  }
  return "active";
}

export function resolveInboundRoutePolicy(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
}): InboundRoutePolicy {
  if (params.channel !== "whatsapp") {
    return DEFAULT_INBOUND_ROUTE_POLICY;
  }

  const account = resolveWhatsAppAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const pauseMode = resolvePauseMode(account.gate?.mode);

  return {
    allowAgentDispatch: pauseMode === "active",
    allowTextCommands: false,
    allowOperationalDirectives: false,
    pauseMode,
    pauseReplyText: account.gate?.replyText?.trim() || undefined,
  };
}
