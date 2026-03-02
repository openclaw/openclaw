import type { RequestClient } from "@buape/carbon";
import type { OpenClawConfig } from "../config/config.js";
import type { GroupPolicy } from "../config/types.base.js";
import type { DiscordGuildEntry } from "../config/types.discord.js";
import { resolveDiscordAccount } from "./accounts.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  type DiscordGuildEntryResolved,
} from "./monitor/allow-list.js";
import { DiscordSendError } from "./send.types.js";

export function enforceOutboundAllowlist(params: {
  cfg: OpenClawConfig;
  accountId: string;
  channelId: string;
  channelName?: string;
  guildId?: string;
  guildName?: string;
  isDm?: boolean;
  isThread?: boolean;
  parentChannelId?: string;
  parentChannelName?: string;
}): void {
  const {
    cfg,
    accountId,
    channelId,
    channelName,
    guildId,
    guildName,
    isDm,
    isThread,
    parentChannelId,
    parentChannelName,
  } = params;

  // DM bypass — DMs are not guild-gated.
  if (isDm) {
    return;
  }

  // Resolve account config (reuses same merge logic as inbound).
  const account = resolveDiscordAccount({ cfg, accountId });
  const discordCfg = account.config;

  // Policy resolution — matches inbound default chain at provider.ts:169.
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy: GroupPolicy = discordCfg.groupPolicy ?? defaultGroupPolicy ?? "open";

  // Open policy: all channels allowed — no guild context needed.
  if (groupPolicy === "open") {
    return;
  }

  // Disabled policy: block everything.
  if (groupPolicy === "disabled") {
    throw new DiscordSendError(
      `Outbound blocked: groupPolicy is "disabled" for account "${accountId}"`,
      { kind: "outbound-blocked", channelId },
    );
  }

  // --- Allowlist policy requires guild context ---
  if (!guildId) {
    throw new DiscordSendError(
      `Outbound blocked: cannot verify allowlist without guild context for channel ${channelId}`,
      { kind: "outbound-blocked", channelId },
    );
  }

  const guildEntries = discordCfg.guilds;

  // No guild entries configured at all → block (no guilds are allowed).
  if (!guildEntries || Object.keys(guildEntries).length === 0) {
    throw new DiscordSendError(
      `Outbound blocked: guild ${guildId} not in allowlist for account "${accountId}"`,
      { kind: "outbound-blocked", channelId },
    );
  }

  // Two-pass guild lookup.
  const guildEntry = resolveGuildEntryForOutbound(guildEntries, guildId, guildName);

  if (!guildEntry) {
    throw new DiscordSendError(
      `Outbound blocked: guild ${guildId} not in allowlist for account "${accountId}"`,
      { kind: "outbound-blocked", channelId },
    );
  }

  // Guild matched. If no channels config, guild-level allow.
  if (!guildEntry.channels || Object.keys(guildEntry.channels).length === 0) {
    return;
  }

  // Resolve channel config using existing helper (handles ID/slug/wildcard/thread→parent fallback).
  const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const parentSlug = parentChannelName ? normalizeDiscordSlug(parentChannelName) : "";
  const useParentFallback = Boolean(isThread && (parentChannelId || parentChannelName));
  const channelConfig = resolveDiscordChannelConfigWithFallback({
    guildInfo: guildEntry,
    channelId,
    channelName,
    channelSlug,
    parentId: useParentFallback ? parentChannelId : undefined,
    parentName: useParentFallback ? parentChannelName : undefined,
    parentSlug: useParentFallback ? parentSlug : "",
    scope: isThread ? "thread" : "channel",
  });

  // Derive policy decision inputs.
  const channelAllowlistConfigured = guildEntry.channels != null;
  const channelAllowed = channelConfig?.allowed !== false;

  const allowed = isDiscordGroupAllowedByPolicy({
    groupPolicy,
    guildAllowlisted: true,
    channelAllowlistConfigured,
    channelAllowed,
  });

  if (!allowed) {
    throw new DiscordSendError(
      `Outbound blocked: channel ${channelId} not in allowlist for guild ${guildId}`,
      { kind: "outbound-blocked", channelId },
    );
  }

  // Check explicit disabled/disallowed flags.
  if (channelConfig?.enabled === false) {
    throw new DiscordSendError(
      `Outbound blocked: channel ${channelId} is disabled in guild ${guildId}`,
      { kind: "outbound-blocked", channelId },
    );
  }
}

/**
 * Two-pass guild lookup for outbound sends.
 *
 * Pass 1 (fast, no API call): check entries[guildId] (ID-keyed) and entries["*"] (wildcard).
 * Pass 2 (slug-keyed): if pass 1 missed and there are non-numeric, non-wildcard keys,
 *   attempt slug match using the provided guildName (if available).
 */
function resolveGuildEntryForOutbound(
  entries: Record<string, DiscordGuildEntry>,
  guildId: string,
  guildName?: string,
): DiscordGuildEntryResolved | null {
  // Pass 1: direct ID match.
  const byId = entries[guildId];
  if (byId) {
    return { ...byId, id: guildId };
  }

  // Pass 1: wildcard match.
  const wildcard = entries["*"];
  if (wildcard) {
    return { ...wildcard, id: guildId };
  }

  // Pass 2: slug-keyed entries need guild name for matching.
  const slugKeys = Object.keys(entries).filter((key) => key !== "*" && !/^\d+$/.test(key));

  if (slugKeys.length === 0) {
    return null;
  }

  // If we have a guild name, try slug match.
  if (guildName) {
    const slug = normalizeDiscordSlug(guildName);
    if (slug) {
      const bySlug = entries[slug];
      if (bySlug) {
        return { ...bySlug, id: guildId, slug };
      }
    }
  }

  return null;
}

/**
 * Async version that can fetch guild name from Discord API for slug resolution.
 * Use when guildName is not available from channel metadata.
 */
export async function enforceOutboundAllowlistAsync(params: {
  cfg: OpenClawConfig;
  accountId: string;
  channelId: string;
  channelName?: string;
  guildId?: string;
  guildName?: string;
  isDm?: boolean;
  isThread?: boolean;
  parentChannelId?: string;
  parentChannelName?: string;
  rest?: RequestClient;
}): Promise<void> {
  const { cfg, accountId, guildId, isDm, rest } = params;

  // Fast path: try sync enforcement first.
  try {
    enforceOutboundAllowlist(params);
    return;
  } catch (err) {
    // Retry once with enriched metadata (guild/channel names) for slug-keyed configs.
    if (!(err instanceof DiscordSendError) || err.kind !== "outbound-blocked" || isDm || !rest) {
      throw err;
    }

    const account = resolveDiscordAccount({ cfg, accountId });
    const guildEntries = account.config.guilds;
    if (!guildEntries) {
      throw err;
    }

    const retryParams = { ...params };
    let enriched = false;

    const guildSlugKeys = Object.keys(guildEntries).filter(
      (key) => key !== "*" && !/^\d+$/.test(key),
    );
    if (guildId && guildSlugKeys.length > 0 && !retryParams.guildName) {
      try {
        const guild = (await rest.get(`/guilds/${guildId}`)) as { name?: string } | undefined;
        if (guild?.name) {
          retryParams.guildName = guild.name;
          enriched = true;
        }
      } catch {
        // best-effort enrichment
      }
    }

    if (!retryParams.channelName) {
      try {
        const channel = (await rest.get(`/channels/${params.channelId}`)) as
          | { name?: string }
          | undefined;
        if (channel?.name) {
          retryParams.channelName = channel.name;
          enriched = true;
        }
      } catch {
        // best-effort enrichment
      }
    }

    if (retryParams.isThread && retryParams.parentChannelId && !retryParams.parentChannelName) {
      try {
        const parent = (await rest.get(`/channels/${retryParams.parentChannelId}`)) as
          | { name?: string }
          | undefined;
        if (parent?.name) {
          retryParams.parentChannelName = parent.name;
          enriched = true;
        }
      } catch {
        // best-effort enrichment
      }
    }

    if (!enriched) {
      throw err;
    }

    enforceOutboundAllowlist(retryParams);
  }
}
