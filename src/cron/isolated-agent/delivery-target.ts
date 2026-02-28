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
import { buildChannelAccountBindings } from "../../routing/bindings.js";
import { normalizeAgentId } from "../../routing/session-key.js";

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
    accountId?: string;
    sessionKey?: string;
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

  // Prefer the thread-specific session entry when a sessionKey is provided.
  const threadEntry =
    jobPayload.sessionKey && jobPayload.sessionKey !== mainSessionKey
      ? store[jobPayload.sessionKey]
      : undefined;
  const entry = threadEntry ?? main;

  const preliminary = resolveSessionDeliveryTarget({
    entry,
    requestedChannel,
    explicitTo,
    allowMismatchedLastTo,
  });

  let fallbackChannel: Exclude<OutboundChannel, "none"> | undefined;
  let ambiguousChannelError: Error | undefined;
  if (!preliminary.channel) {
    try {
      const selection = await resolveMessageChannelSelection({ cfg });
      fallbackChannel = selection.channel;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Channel is required")) {
        ambiguousChannelError = err instanceof Error ? err : new Error(msg);
      } else {
        fallbackChannel = preliminary.lastChannel ?? DEFAULT_CHAT_CHANNEL;
      }
    }
  }

  if (ambiguousChannelError) {
    return {
      ok: false,
      channel: undefined as unknown as Exclude<OutboundChannel, "none">,
      mode: "implicit",
      error: ambiguousChannelError,
    };
  }

  const resolved = fallbackChannel
    ? resolveSessionDeliveryTarget({
        entry,
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

  // Prefer an explicit accountId from the job's delivery config (set via
  // --account on cron add/edit). Fall back to the session's lastAccountId,
  // then to the agent's bound account from bindings config.
  const explicitAccountId =
    typeof jobPayload.accountId === "string" && jobPayload.accountId.trim()
      ? jobPayload.accountId.trim()
      : undefined;
  let accountId = explicitAccountId ?? resolved.accountId;
  if (!accountId && channel) {
    const bindings = buildChannelAccountBindings(cfg);
    const byAgent = bindings.get(channel);
    const boundAccounts = byAgent?.get(normalizeAgentId(agentId));
    if (boundAccounts && boundAccounts.length > 0) {
      accountId = boundAccounts[0];
    }
  }

  // Carry threadId when it was explicitly set (from :topic: parsing or config)
  // or when delivering to the same recipient as the session's last conversation.
  // Session-derived threadIds are dropped when the target differs to prevent
  // stale thread IDs from leaking to a different chat.
  const threadId =
    resolved.threadId &&
    (resolved.threadIdExplicit || (resolved.to && resolved.to === resolved.lastTo))
      ? resolved.threadId
      : undefined;

  if (!toCandidate) {
    return {
      ok: false,
      channel,
      accountId,
      threadId,
      mode,
      error: new Error(`No delivery target resolved for channel "${channel}"`),
    };
  }

  const docked = resolveOutboundTarget({
    channel,
    to: toCandidate,
    cfg,
    accountId,
    mode,
  });
  if (!docked.ok) {
    return {
      ok: false,
      channel,
      accountId,
      threadId,
      mode,
      error: docked.error,
    };
  }
  return {
    ok: true,
    channel,
    to: docked.to,
    accountId,
    threadId,
    mode,
  };
}
