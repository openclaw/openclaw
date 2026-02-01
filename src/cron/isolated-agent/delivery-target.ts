import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
import { DEFAULT_CHAT_CHANNEL } from "../../channels/registry.js";
import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveStorePath,
} from "../../config/sessions.js";
import { listDiscordAccountIds } from "../../discord/accounts.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
} from "../../infra/outbound/targets.js";

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

  const preliminary = resolveSessionDeliveryTarget({
    entry: main,
    requestedChannel,
    explicitTo,
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
        explicitTo,
        fallbackChannel,
        allowMismatchedLastTo: true,
        mode: preliminary.mode,
      })
    : preliminary;

  const channel = resolved.channel ?? fallbackChannel ?? DEFAULT_CHAT_CHANNEL;
  const mode = resolved.mode as "explicit" | "implicit";
  const toCandidate = resolved.to;

  // Auto-map agentId to accountId if not resolved from session and agentId matches a Discord account.
  // This allows cron jobs with agentId="agent-b" to automatically use the matching Discord account.
  let accountId = resolved.accountId;
  if (!accountId && channel === "discord" && agentId) {
    const discordAccountIds = listDiscordAccountIds(cfg);
    if (discordAccountIds.includes(agentId)) {
      accountId = agentId;
    }
  }

  if (!toCandidate) {
    return { channel, to: undefined, accountId, mode };
  }

  const docked = resolveOutboundTarget({
    channel,
    to: toCandidate,
    cfg,
    accountId,
    mode,
  });
  return {
    channel,
    to: docked.ok ? docked.to : undefined,
    accountId,
    mode,
    error: docked.ok ? undefined : docked.error,
  };
}
