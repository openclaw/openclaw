import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import type { GatewayRequestContext } from "./types.js";

export async function resolveRequestedChannel(params: {
  requestChannel: unknown;
  unsupportedMessage: (input: string) => string;
  context: GatewayRequestContext;
  config?: OpenClawConfig;
  rejectWebchatAsInternalOnly?: boolean;
}) {
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
      channel = (await resolveMessageChannelSelection({ cfg })).channel;
    } catch (err) {
      return { error: errorShape(ErrorCodes.INVALID_REQUEST, String(err)) };
    }
  }
  return { cfg, channel };
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
