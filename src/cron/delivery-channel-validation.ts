// Channel-aware cron delivery validation for gateway-owned mutations.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listConfiguredMessageChannels } from "../infra/outbound/channel-selection.js";
import {
  resolveTargetPrefixedChannel,
  validateTargetProviderPrefix,
} from "../infra/outbound/channel-target-prefix.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import type { CronDelivery, CronJobCreate } from "./types.js";

async function listConfiguredAnnounceChannelIds(cfg: OpenClawConfig): Promise<string[]> {
  return await listConfiguredMessageChannels(cfg);
}

function hasExplicitChannelConfigEntry(cfg: OpenClawConfig): boolean {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return false;
  }
  return Object.entries(channels).some(([channelId, entry]) => {
    if (channelId === "defaults" || channelId === "modelByChannel") {
      return false;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return false;
    }
    return Object.keys(entry).length > 0;
  });
}

async function assertConfiguredAnnounceChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
  field: "delivery.channel" | "delivery.failureDestination.channel";
}) {
  // `last` defers channel selection to runtime session context; every concrete
  // announce channel must be one the gateway can actually deliver through.
  if (params.channel === "last") {
    return;
  }

  const configuredChannels = (await listConfiguredAnnounceChannelIds(params.cfg)).toSorted();
  const normalizedChannel = normalizeMessageChannel(params.channel);
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

  if (configuredChannels.includes(normalizedChannel)) {
    return;
  }

  throw new Error(`${params.field} must be one of: ${configuredChannels.join(", ")}`);
}

function resolveAnnounceValidationChannel(params: {
  channel?: string;
  to?: string;
}): string | undefined {
  // A target like `telegram:...` is enough to validate the announce channel
  // even when the explicit channel field is omitted.
  if (params.channel && params.channel !== "last") {
    return params.channel;
  }
  return resolveTargetPrefixedChannel(params.to) ?? params.channel;
}

function assertCompatibleAnnounceTarget(params: {
  channel?: string;
  to?: string;
  field: "delivery.channel" | "delivery.failureDestination.channel";
}) {
  if (!params.channel || params.channel === "last") {
    return;
  }
  const error = validateTargetProviderPrefix({
    channel: params.channel,
    to: params.to,
  });
  if (error) {
    throw new Error(`${params.field}: ${error.message}`);
  }
}

export async function assertValidCronAnnounceDelivery(params: {
  cfg: OpenClawConfig;
  delivery?: CronDelivery;
}) {
  if (params.delivery && (params.delivery.mode ?? "announce") === "announce") {
    assertCompatibleAnnounceTarget({
      channel: params.delivery.channel,
      to: params.delivery.to,
      field: "delivery.channel",
    });
    await assertConfiguredAnnounceChannel({
      cfg: params.cfg,
      channel: resolveAnnounceValidationChannel({
        channel: params.delivery.channel,
        to: params.delivery.to,
      }),
      field: "delivery.channel",
    });
  }

  const failureDestination = params.delivery?.failureDestination;
  if (failureDestination && (failureDestination.mode ?? "announce") === "announce") {
    if (
      failureDestination.channel === undefined &&
      failureDestination.to === undefined &&
      failureDestination.accountId === undefined &&
      failureDestination.mode === undefined
    ) {
      return;
    }
    assertCompatibleAnnounceTarget({
      channel: failureDestination.channel,
      to: failureDestination.to,
      field: "delivery.failureDestination.channel",
    });
    await assertConfiguredAnnounceChannel({
      cfg: params.cfg,
      channel: resolveAnnounceValidationChannel({
        channel: failureDestination.channel,
        to: failureDestination.to,
      }),
      field: "delivery.failureDestination.channel",
    });
  }
}

export async function assertValidCronCreateDelivery(cfg: OpenClawConfig, jobCreate: CronJobCreate) {
  await assertValidCronAnnounceDelivery({
    cfg,
    delivery: jobCreate.delivery,
  });
}
