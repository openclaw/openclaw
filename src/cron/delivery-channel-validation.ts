// Channel-aware cron delivery validation for gateway-owned mutations.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listConfiguredMessageChannels } from "../infra/outbound/channel-selection.js";
import {
  resolveTargetPrefixedChannel,
  validateTargetProviderPrefix,
} from "../infra/outbound/channel-target-prefix.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import { assertCanonicalCronDeliveryMode } from "./store/delivery-codec.js";
import type { CronDelivery } from "./types.js";

function hasExplicitChannelConfigEntry(cfg: OpenClawConfig): boolean {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return false;
  }
  return Object.entries(channels).some(([channelId, entry]) => {
    if (channelId === "defaults" || channelId === "modelByChannel") {
      return false;
    }
    return Boolean(
      entry && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length > 0,
    );
  });
}

async function assertConfiguredAnnounceChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
  field: "delivery.channel";
}) {
  if (params.channel === "last") {
    return;
  }
  const normalizedChannel = normalizeMessageChannel(params.channel);
  if (!normalizedChannel && params.field === "delivery.channel") {
    // Primary implicit routing is service-owned because session-backed and
    // best-effort jobs must remain valid even on multi-channel hosts.
    return;
  }
  const configuredChannels = (await listConfiguredMessageChannels(params.cfg)).toSorted();
  if (!normalizedChannel) {
    if (configuredChannels.length <= 1) {
      return;
    }
    throw new Error(
      `${params.field} is required when multiple channels are configured: ${configuredChannels.join(", ")}`,
    );
  }
  if (configuredChannels.length === 0) {
    if (!hasExplicitChannelConfigEntry(params.cfg)) {
      if (!isDeliverableMessageChannel(normalizedChannel)) {
        throw new Error(`${params.field} is not a known channel: ${normalizedChannel}`);
      }
      return;
    }
    throw new Error(`${params.field} is not configured: ${normalizedChannel}`);
  }
  if (!configuredChannels.includes(normalizedChannel)) {
    throw new Error(`${params.field} must be one of: ${configuredChannels.join(", ")}`);
  }
}

/**
 * Rejects an announce account the operator has turned off in config, so a job is
 * not scheduled against a route its owner already disabled - the same late failure
 * this file prevents for `channel`.
 *
 * Scoped to a matching `accounts.<id>.enabled: false` entry, and nothing else.
 * Cron delivery ids are not always operator-typed (`delivery-context.ts` copies
 * the current context account into inferred jobs); channel `isEnabled` adapters
 * report unlisted or credential-suppressed accounts as not enabled; and a
 * top-level `channels.<id>.enabled: false` is not uniformly channel-wide - twitch
 * resolves named accounts from `accounts` alone. Only the account entry itself is
 * an unambiguous statement about this route.
 */
function assertEnabledAnnounceAccount(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
  field: "delivery.accountId";
}) {
  if (!params.accountId || !params.channel || params.channel === "last") {
    return;
  }
  // Aliases are valid delivery channels (`urbit` -> `tlon`) but config lives under
  // the canonical id, so normalize before reading it.
  const channel = normalizeMessageChannel(params.channel) ?? params.channel;
  const channelConfig = (params.cfg.channels as Record<string, unknown> | undefined)?.[channel];
  if (!channelConfig || typeof channelConfig !== "object" || Array.isArray(channelConfig)) {
    return;
  }
  const accounts = (channelConfig as { accounts?: Record<string, { enabled?: unknown }> }).accounts;
  // Channels resolve account keys canonically (matrix `"Team Ops"` answers to
  // `team-ops`), so match the same way or a disabled entry is missed.
  if (
    resolveChannelAccountEntry(accounts, params.accountId, channel, normalizeAccountId)?.enabled !==
    false
  ) {
    return;
  }
  throw new Error(
    `${params.field}: account "${params.accountId}" is disabled for channel ${channel}`,
  );
}

function resolveAnnounceValidationChannel(params: {
  channel?: string;
  to?: string;
}): string | undefined {
  return params.channel && params.channel !== "last"
    ? params.channel
    : (resolveTargetPrefixedChannel(params.to) ?? params.channel);
}

function assertCompatibleAnnounceTarget(params: {
  channel?: string;
  to?: string;
  field: "delivery.channel";
}) {
  if (!params.channel || params.channel === "last") {
    return;
  }
  const error = validateTargetProviderPrefix({ channel: params.channel, to: params.to });
  if (error) {
    throw new Error(`${params.field}: ${error.message}`);
  }
}

export async function assertValidCronAnnounceDelivery(params: {
  cfg: OpenClawConfig;
  delivery?: CronDelivery;
}) {
  assertCanonicalCronDeliveryMode(params.delivery);
  if (params.delivery?.mode === "announce") {
    assertCompatibleAnnounceTarget({
      channel: params.delivery.channel,
      to: params.delivery.to,
      field: "delivery.channel",
    });
    await assertConfiguredAnnounceChannel({
      cfg: params.cfg,
      channel: resolveAnnounceValidationChannel(params.delivery),
      field: "delivery.channel",
    });
    assertEnabledAnnounceAccount({
      cfg: params.cfg,
      channel: resolveAnnounceValidationChannel(params.delivery),
      accountId: params.delivery.accountId,
      field: "delivery.accountId",
    });
  }
}
