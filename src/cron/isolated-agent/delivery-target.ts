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
import { deliveryContextFromSession } from "../../utils/delivery-context.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel.js";

/**
 * When the main session's lastChannel doesn't match the requested channel,
 * scan all session entries for the same agent to find one whose lastChannel
 * matches. This handles the common case where the user configured a cron to
 * deliver on a specific channel (e.g. Telegram) but their main session's
 * lastChannel has since changed to another channel (e.g. webchat), or was
 * never set for that channel.
 *
 * See: https://github.com/openclaw/openclaw/issues/14646
 * See: https://github.com/openclaw/openclaw/issues/14743
 * See: https://github.com/openclaw/openclaw/issues/14753
 */
function findDeliveryTargetFromStore(
  store: Record<string, unknown>,
  requestedChannel: string,
  excludeKey?: string,
): { to: string; accountId?: string; threadId?: string | number } | undefined {
  for (const [key, entry] of Object.entries(store)) {
    if (key === excludeKey || !entry || typeof entry !== "object") {
      continue;
    }
    const ctx = deliveryContextFromSession(
      entry as Parameters<typeof deliveryContextFromSession>[0],
    );
    if (
      ctx?.channel === requestedChannel &&
      typeof ctx.to === "string" &&
      ctx.to.trim().length > 0
    ) {
      return { to: ctx.to, accountId: ctx.accountId, threadId: ctx.threadId };
    }
  }
  return undefined;
}

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
  let toCandidate = resolved.to;
  let accountId = resolved.accountId;

  // #14646 / #14743 / #14753: When an explicit channel is requested but the
  // main session's lastChannel doesn't match (e.g. user interacts via Telegram
  // DMs but main session lastChannel was set to webchat, or was cleared after a
  // restart), the initial resolution can't find a `to`. Fall back to scanning
  // the session store for ANY entry that was last used on the requested channel.
  if (
    !toCandidate &&
    !explicitTo &&
    requestedChannel !== "last" &&
    isDeliverableMessageChannel(channel)
  ) {
    const storeHit = findDeliveryTargetFromStore(store, channel, mainSessionKey);
    if (storeHit) {
      toCandidate = storeHit.to;
      accountId = storeHit.accountId ?? accountId;
    }
  }

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
      channel,
      to: undefined,
      accountId,
      threadId,
      mode,
    };
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
    threadId,
    mode,
    error: docked.ok ? undefined : docked.error,
  };
}
