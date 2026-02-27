import type { ChannelId } from "../../channels/plugins/types.js";
import type { BotConfig } from "../../config/config.js";
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

/**
 * Result of resolving a cron delivery target.
 * When `ok` is `true` the `to` field is a non-empty string and `error` is
 * absent. When `ok` is `false` an `error` is present.
 */
export type DeliveryTargetResolution = {
  ok: boolean;
  channel: Exclude<OutboundChannel, "none">;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  mode: "explicit" | "implicit";
  error?: Error;
};

export async function resolveDeliveryTarget(
  cfg: BotConfig,
  agentId: string,
  jobPayload: {
    channel?: "last" | ChannelId;
    to?: string;
  },
): Promise<DeliveryTargetResolution> {
  const requestedChannel = typeof jobPayload.channel === "string" ? jobPayload.channel : "last";
  const explicitTo = typeof jobPayload.to === "string" ? jobPayload.to : undefined;
  const allowMismatchedLastTo = requestedChannel === "last";

  const sessionCfg = cfg.session;
  const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const main = store[mainSessionKey];

  const preliminary = resolveSessionDeliveryTarget({
    entry: main,
    requestedChannel,
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
        requestedChannel,
        explicitTo,
        fallbackChannel,
        allowMismatchedLastTo,
        mode: preliminary.mode,
      })
    : preliminary;

  const channel = resolved.channel ?? fallbackChannel ?? DEFAULT_CHAT_CHANNEL;
  const mode = resolved.mode as "explicit" | "implicit";
  const toCandidate = resolved.to;

  // Only carry threadId when delivering to the same recipient as the session's
  // last conversation. This prevents stale thread IDs (e.g. from a Telegram
  // supergroup topic) from being sent to a different target (e.g. a private
  // chat) where they would cause API errors.
  const threadId =
    resolved.threadId && resolved.to && resolved.to === resolved.lastTo
      ? resolved.threadId
      : undefined;

  if (!toCandidate) {
    return {
      ok: false,
      channel,
      accountId: resolved.accountId,
      threadId,
      mode,
      error: new Error("delivery target missing"),
    };
  }

  const docked = resolveOutboundTarget({
    channel,
    to: toCandidate,
    cfg,
    accountId: resolved.accountId,
    mode,
  });
  if (!docked.ok) {
    return {
      ok: false,
      channel,
      accountId: resolved.accountId,
      threadId,
      mode,
      error: docked.error,
    };
  }
  return {
    ok: true,
    channel,
    to: docked.to,
    accountId: resolved.accountId,
    threadId,
    mode,
  };
}
