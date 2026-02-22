import type { ChannelId } from "../../channels/plugins/types.js";
import { DEFAULT_CHAT_CHANNEL } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveStorePath,
} from "../../config/sessions.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
import {
  resolveOutboundTarget,
  resolveSessionDeliveryTarget,
} from "../../infra/outbound/targets.js";
import { readChannelAllowFromStoreSync } from "../../pairing/pairing-store.js";
import { buildChannelAccountBindings } from "../../routing/bindings.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveWhatsAppAccount } from "../../web/accounts.js";
import { normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";

export async function resolveDeliveryTarget(
  cfg: OpenClawConfig,
  agentId: string,
  jobPayload: {
    channel?: "last" | ChannelId;
    to?: string;
    sessionKey?: string;
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

  // Look up thread-specific session first (e.g. agent:main:main:thread:1234),
  // then fall back to the main session entry.
  const threadSessionKey = jobPayload.sessionKey?.trim();
  const threadEntry = threadSessionKey ? store[threadSessionKey] : undefined;
  const main = threadEntry ?? store[mainSessionKey];

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

  // When the session has no lastAccountId (e.g. first-run isolated cron
  // session), fall back to the agent's bound account from bindings config.
  // This ensures the message tool in isolated sessions resolves the correct
  // bot token for multi-account setups.
  let accountId = resolved.accountId;
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
      channel,
      to: undefined,
      accountId,
      threadId,
      mode,
    };
  }

  let allowFromOverride: string[] | undefined;
  if (channel === "whatsapp") {
    const configuredAllowFromRaw = resolveWhatsAppAccount({ cfg, accountId }).allowFrom ?? [];
    const configuredAllowFrom = configuredAllowFromRaw
      .map((entry) => String(entry).trim())
      .filter((entry) => entry && entry !== "*")
      .map((entry) => normalizeWhatsAppTarget(entry))
      .filter((entry): entry is string => Boolean(entry));
    const storeAllowFrom = readChannelAllowFromStoreSync("whatsapp", process.env, accountId)
      .map((entry) => normalizeWhatsAppTarget(entry))
      .filter((entry): entry is string => Boolean(entry));
    allowFromOverride = [...new Set([...configuredAllowFrom, ...storeAllowFrom])];

    if (mode === "implicit" && allowFromOverride.length > 0) {
      const normalizedCurrentTarget = normalizeWhatsAppTarget(toCandidate);
      if (!normalizedCurrentTarget || !allowFromOverride.includes(normalizedCurrentTarget)) {
        toCandidate = allowFromOverride[0];
      }
    }
  }

  const docked = resolveOutboundTarget({
    channel,
    to: toCandidate,
    cfg,
    accountId,
    mode,
    allowFrom: allowFromOverride,
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
