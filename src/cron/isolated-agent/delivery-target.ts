import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
import { DEFAULT_CHAT_CHANNEL } from "../../channels/registry.js";
import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveStorePath,
} from "../../config/sessions.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
} from "../../infra/outbound/targets.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";

export async function resolveDeliveryTarget(
  cfg: OpenClawConfig,
  agentId: string,
  jobPayload: {
    channel?: "last" | ChannelId;
    to?: string;
  },
): Promise<{
  channel: Exclude<OutboundChannel, "none">;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  mode: "explicit" | "implicit";
  error?: Error;
}> {
  const requestedChannelRaw = typeof jobPayload.channel === "string" ? jobPayload.channel : "last";
  const requestedChannelNormalized =
    requestedChannelRaw === "last"
      ? "last"
      : (normalizeMessageChannel(requestedChannelRaw) ?? requestedChannelRaw);
  const explicitTo = typeof jobPayload.to === "string" ? jobPayload.to : undefined;
  const allowMismatchedLastTo = requestedChannelNormalized === "last";

  // Allow explicitly requesting the internal webchat channel as a messageChannel for the agent,
  // even though it is not deliverable via outbound providers.
  if (requestedChannelNormalized === INTERNAL_MESSAGE_CHANNEL) {
    const channel = INTERNAL_MESSAGE_CHANNEL;
    const mode = explicitTo ? "explicit" : "implicit";
    if (!explicitTo) {
      return { channel, to: undefined, mode };
    }
    const docked = resolveOutboundTarget({ channel, to: explicitTo, cfg, mode });
    return {
      channel,
      to: docked.ok ? docked.to : undefined,
      mode,
      error: docked.ok ? undefined : docked.error,
    };
  }

  const sessionCfg = cfg.session;
  const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const main = store[mainSessionKey];

  const preliminary = resolveSessionDeliveryTarget({
    entry: main,
    requestedChannel: requestedChannelNormalized,
    explicitTo,
    allowMismatchedLastTo,
  });

  let fallbackChannel: Exclude<OutboundChannel, "none"> | undefined;
  if (!preliminary.channel) {
    try {
      const selection = await resolveMessageChannelSelection({ cfg });
      fallbackChannel = selection.channel;
    } catch {
      fallbackChannel = preliminary.lastChannel ?? DEFAULT_CHAT_CHANNEL;
    }
  }

  const resolved = fallbackChannel
    ? resolveSessionDeliveryTarget({
        entry: main,
        requestedChannel: requestedChannelNormalized,
        explicitTo,
        fallbackChannel,
        allowMismatchedLastTo,
        mode: preliminary.mode,
      })
    : preliminary;

  const channel = resolved.channel ?? fallbackChannel ?? DEFAULT_CHAT_CHANNEL;
  const mode = resolved.mode as "explicit" | "implicit";
  const toCandidate = resolved.to;

  if (!toCandidate) {
    return {
      channel,
      to: undefined,
      accountId: resolved.accountId,
      threadId: resolved.threadId,
      mode,
    };
  }

  const docked = resolveOutboundTarget({
    channel,
    to: toCandidate,
    cfg,
    accountId: resolved.accountId,
    mode,
  });
  return {
    channel,
    to: docked.ok ? docked.to : undefined,
    accountId: resolved.accountId,
    threadId: resolved.threadId,
    mode,
    error: docked.ok ? undefined : docked.error,
  };
}
