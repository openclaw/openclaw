import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
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
import { deliveryContextFromSession } from "../../utils/delivery-context.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

export async function resolveDeliveryTarget(
  cfg: OpenClawConfig,
  agentId: string,
  jobPayload: {
    channel?: "last" | ChannelId;
    to?: string;
    explicitChannel?: boolean;
  },
): Promise<{
  channel: GatewayMessageChannel;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  mode: "explicit" | "implicit";
  error?: Error;
}> {
  const requestedChannelRaw = typeof jobPayload.channel === "string" ? jobPayload.channel : "last";
  const explicitTo = typeof jobPayload.to === "string" ? jobPayload.to : undefined;
  const explicitChannelRequested =
    jobPayload.explicitChannel === true && requestedChannelRaw !== "last";
  const normalizedRequested =
    requestedChannelRaw === "last"
      ? "last"
      : (normalizeMessageChannel(requestedChannelRaw) ?? requestedChannelRaw.trim().toLowerCase());

  const sessionCfg = cfg.session;
  const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const main = store[mainSessionKey];
  const context = deliveryContextFromSession(main);

  if (
    explicitChannelRequested &&
    normalizedRequested !== "last" &&
    !isDeliverableMessageChannel(normalizedRequested)
  ) {
    const lastChannel = context?.channel;
    const lastTo = context?.to;
    const matchLast = lastChannel === normalizedRequested;
    return {
      channel: normalizedRequested as GatewayMessageChannel,
      to: explicitTo ?? (matchLast ? lastTo : undefined),
      accountId: matchLast ? context?.accountId : undefined,
      threadId: matchLast ? context?.threadId : undefined,
      mode: explicitTo ? "explicit" : "implicit",
    };
  }

  const preliminary = resolveSessionDeliveryTarget({
    entry: main,
    requestedChannel: normalizedRequested === "last" ? "last" : normalizedRequested,
    explicitTo,
    allowMismatchedLastTo: true,
  });

  let fallbackChannel: Exclude<OutboundChannel, "none"> | undefined;
  if (!preliminary.channel && !explicitChannelRequested) {
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
        requestedChannel: normalizedRequested === "last" ? "last" : normalizedRequested,
        explicitTo,
        fallbackChannel,
        allowMismatchedLastTo: true,
        mode: preliminary.mode,
      })
    : preliminary;

  const channel = resolved.channel ?? fallbackChannel ?? DEFAULT_CHAT_CHANNEL;
  const mode = resolved.mode as "explicit" | "implicit";
  const toCandidate = resolved.to;

  if (!toCandidate) {
    return {
      channel: channel as GatewayMessageChannel,
      to: undefined,
      accountId: resolved.accountId,
      threadId: resolved.threadId,
      mode,
    };
  }

  const docked = resolveOutboundTarget({
    channel: channel as GatewayMessageChannel,
    to: toCandidate,
    cfg,
    accountId: resolved.accountId,
    mode,
  });
  return {
    channel: channel as GatewayMessageChannel,
    to: docked.ok ? docked.to : undefined,
    accountId: resolved.accountId,
    threadId: resolved.threadId,
    mode,
    error: docked.ok ? undefined : docked.error,
  };
}
