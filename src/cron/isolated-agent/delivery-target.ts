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
import { logWarn } from "../../logger.js";

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
  const requestedChannel = typeof jobPayload.channel === "string" ? jobPayload.channel : "last";
  const explicitTo = typeof jobPayload.to === "string" ? jobPayload.to : undefined;

  const sessionCfg = cfg.session;
  const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const main = store[mainSessionKey];

  // When the job requests a specific channel and the session's lastChannel differs,
  // scan all sessions for a recent delivery context matching the requested channel.
  // This prevents cross-channel pollution where e.g. WhatsApp activity overwrites
  // the Telegram delivery target.
  let channelMatchedTo = explicitTo;
  if (!channelMatchedTo && requestedChannel !== "last" && main) {
    const lastChannel = main.lastChannel ?? main.deliveryContext?.channel;
    if (lastChannel && lastChannel !== requestedChannel) {
      // lastChannel differs from requested — look through session store for a
      // session that last interacted on the requested channel.
      for (const key of Object.keys(store)) {
        const entry = store[key];
        if (!entry) continue;
        const entryChannel = entry.lastChannel ?? entry.deliveryContext?.channel;
        const entryTo = entry.lastTo ?? entry.deliveryContext?.to;
        if (entryChannel === requestedChannel && entryTo) {
          channelMatchedTo = entryTo;
          break;
        }
      }
      if (!channelMatchedTo) {
        logWarn(
          `[cron] Delivery channel "${requestedChannel}" requested but lastChannel is "${lastChannel}" ` +
            `and no session with a matching delivery context was found. ` +
            `Consider adding an explicit "to" to the cron job delivery config.`,
        );
      }
    }
  }

  const preliminary = resolveSessionDeliveryTarget({
    entry: main,
    requestedChannel,
    explicitTo: channelMatchedTo,
    allowMismatchedLastTo: true,
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
        requestedChannel,
        explicitTo: channelMatchedTo,
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
