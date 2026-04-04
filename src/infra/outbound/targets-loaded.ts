import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelOutboundTargetMode, ChannelPlugin } from "../../channels/plugins/types.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { missingTargetError } from "./target-errors.js";
import type { OutboundTargetResolution } from "./targets.js";

function resolveLoadedOutboundChannelPlugin(channel: string): ChannelPlugin | undefined {
  const normalized = normalizeMessageChannel(channel);
  if (!normalized || !isDeliverableMessageChannel(normalized)) {
    return undefined;
  }

  const current = getChannelPlugin(normalized);
  if (current) {
    return current;
  }

  const activeRegistry = getActivePluginRegistry();
  if (!activeRegistry) {
    return undefined;
  }
  for (const entry of activeRegistry.channels) {
    const plugin = entry?.plugin;
    if (plugin?.id === normalized) {
      return plugin;
    }
  }
  return undefined;
}

export function tryResolveLoadedOutboundTarget(params: {
  channel: GatewayMessageChannel;
  to?: string;
  allowFrom?: string[];
  cfg?: OpenClawConfig;
  accountId?: string | null;
  mode?: ChannelOutboundTargetMode;
}): OutboundTargetResolution | undefined {
  if (params.channel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      ok: false,
      error: new Error(
        `Delivering to WebChat is not supported via \`${formatCliCommand("openclaw agent")}\`; use WhatsApp/Telegram or run with --deliver=false.`,
      ),
    };
  }

  const plugin = resolveLoadedOutboundChannelPlugin(params.channel);
  if (!plugin) {
    return undefined;
  }

  const allowFromRaw =
    params.allowFrom ??
    (params.cfg && plugin.config.resolveAllowFrom
      ? plugin.config.resolveAllowFrom({
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
      : undefined);
  const allowFrom = allowFromRaw ? mapAllowFromEntries(allowFromRaw) : undefined;

  const effectiveTo =
    params.to?.trim() ||
    (params.cfg && plugin.config.resolveDefaultTo
      ? plugin.config.resolveDefaultTo({
          cfg: params.cfg,
          accountId: params.accountId ?? undefined,
        })
      : undefined);

  const resolveTarget = plugin.outbound?.resolveTarget;
  if (resolveTarget) {
    return resolveTarget({
      cfg: params.cfg,
      to: effectiveTo,
      allowFrom,
      accountId: params.accountId ?? undefined,
      mode: params.mode ?? "explicit",
    });
  }

  if (effectiveTo) {
    return { ok: true, to: effectiveTo };
  }
  const hint = plugin.messaging?.targetResolver?.hint;
  return {
    ok: false,
    error: missingTargetError(plugin.meta.label ?? params.channel, hint),
  };
}
