import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAnyChannelId } from "../registry.js";
import type { ChannelMessageActionDiscoveryContext } from "./types.js";

export type ChannelMessageActionDiscoveryInput = {
  cfg?: OpenClawConfig;
  channel?: string | null;
  currentChannelProvider?: string | null;
  currentChannelId?: string | null;
  currentThreadTs?: string | null;
  currentMessageId?: string | number | null;
  accountId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  requesterSenderId?: string | null;
};

export function resolveMessageActionDiscoveryChannelId(raw?: string | null): string | undefined {
  const normalized = normalizeAnyChannelId(raw);
  if (normalized) {
    return normalized;
  }
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

export function createMessageActionDiscoveryContext(
  params: ChannelMessageActionDiscoveryInput,
): ChannelMessageActionDiscoveryContext {
  const currentChannelProvider = resolveMessageActionDiscoveryChannelId(
    params.channel ?? params.currentChannelProvider,
  );
  return {
    cfg: params.cfg ?? ({} as OpenClawConfig),
    currentChannelId: params.currentChannelId,
    currentChannelProvider,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    accountId: params.accountId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    requesterSenderId: params.requesterSenderId,
  };
}
