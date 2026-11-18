import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { MsgContext, OriginatingChannelType } from "../templating.js";

/** Retain the native source separately from the reply destination for queued turns. */
export function slackNativeMessageOrigin(ctx: MsgContext): string | undefined {
  const channel = ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface;
  return normalizeMessageChannel(channel) === "slack" ? ctx.NativeChannelId : undefined;
}

/** Resolves the original message provider before reply redirection. */
export function resolveOriginMessageProvider(params: {
  originatingChannel?: OriginatingChannelType;
  provider?: string;
}): string | undefined {
  return (
    normalizeMessageChannel(params.originatingChannel) ?? normalizeMessageChannel(params.provider)
  );
}
