import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { CHANNEL_MESSAGE_ACTION_NAMES } from "../../channels/plugins/message-action-names.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { selectLiveRuntimeConfig } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOutboundChannelPlugin } from "../../infra/outbound/channel-resolution.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import type { GatewayRequestContext } from "./types.js";

type RequestedChannelParams = {
  requestChannel: unknown;
  unsupportedMessage: (input: string) => string;
  context: GatewayRequestContext;
  config?: OpenClawConfig;
};

export async function resolveRequestedChannel(
  params: RequestedChannelParams & {
    rejectWebchatAsInternalOnly?: boolean;
    action?: ChannelMessageActionName;
  },
) {
  const channelInput = readStringValue(params.requestChannel);
  const normalizedChannel = channelInput ? normalizeMessageChannel(channelInput) : undefined;
  if (params.rejectWebchatAsInternalOnly && normalizedChannel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "unsupported channel: webchat (internal-only). Use `chat.send` for WebChat UI messages or choose a deliverable channel.",
      ),
    };
  }
  if (channelInput && !normalizedChannel) {
    return {
      error: errorShape(ErrorCodes.INVALID_REQUEST, params.unsupportedMessage(channelInput)),
    };
  }
  const cfg = params.config ?? params.context.getRuntimeConfig();
  let channel = normalizedChannel;
  if (!channel) {
    try {
      channel = (await resolveMessageChannelSelection({ cfg, action: params.action })).channel;
    } catch (err) {
      return { error: errorShape(ErrorCodes.INVALID_REQUEST, String(err)) };
    }
  }
  return { cfg, channel };
}

export async function resolveRequestedMessageActionChannel(
  params: RequestedChannelParams & { action: string },
) {
  const action = CHANNEL_MESSAGE_ACTION_NAMES.find((name) => name === params.action);
  const resolved = await resolveRequestedChannel({
    ...params,
    action,
    rejectWebchatAsInternalOnly: true,
  });
  if ("error" in resolved) {
    return { error: resolved.error };
  }
  const { channel } = resolved;
  const cfg = params.config ?? selectLiveRuntimeConfig(resolved.cfg);
  const plugin = resolveOutboundChannelPlugin({ channel, cfg, action });
  const canonicalAction =
    ((params.action === "send" &&
      Boolean(plugin?.message?.send?.text || plugin?.outbound?.sendText)) ||
      (params.action === "poll" && Boolean(plugin?.outbound?.sendPoll))) &&
    (!plugin?.actions?.handleAction ||
      plugin.actions.supportsAction?.({ action: params.action }) === false);
  if (!plugin || (!plugin.actions?.handleAction && !canonicalAction)) {
    return {
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Channel ${channel} does not support action ${params.action}.`,
      ),
    };
  }
  return { cfg, channel, plugin, canonicalAction };
}

export async function resolveGatewayOutboundTarget(params: {
  channel: string;
  to: string;
  cfg: OpenClawConfig;
  accountId?: string;
}) {
  const resolved = await resolveOutboundTarget({
    ...params,
    mode: "explicit",
  });
  if (!resolved.ok) {
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)),
    };
  }
  return { ok: true as const, to: resolved.to };
}
