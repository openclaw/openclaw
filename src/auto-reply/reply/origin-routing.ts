import { normalizeMessageChannel } from "../../utils/message-channel.js";
import type { OriginatingChannelType } from "../templating.js";
import type { FollowupRun } from "./queue/types.js";

/** Resolves the original message provider before reply redirection. */
export function resolveOriginMessageProvider(params: {
  originatingChannel?: OriginatingChannelType;
  provider?: string;
}): string | undefined {
  return (
    normalizeMessageChannel(params.originatingChannel) ?? normalizeMessageChannel(params.provider)
  );
}

export function resolveFollowupReplyOrigin(queued: FollowupRun) {
  const provider = resolveOriginMessageProvider({ provider: queued.run.messageProvider });
  const origin = resolveOriginMessageProvider({ originatingChannel: queued.originatingChannel });
  const sameChannelOrigin = Boolean(origin && origin === provider);
  const provenance = queued.run.inputProvenance;
  const inboundChannel = resolveOriginMessageProvider({
    provider:
      queued.messageIdChannel === undefined
        ? provenance?.sourceChannel
        : (queued.messageIdChannel ?? undefined),
  });
  const userMessage = provenance?.kind === undefined || provenance.kind === "external_user";
  // Restart continuations carry a separate platform anchor. Their messageId belongs to the gateway.
  const currentMessageId =
    provenance?.kind === "internal_system" && provenance.sourceTool === "restart-sentinel"
      ? queued.originatingReplyToId
      : origin && inboundChannel === origin && userMessage
        ? queued.messageId
        : undefined;
  return {
    sameChannelOrigin,
    crossChannelOrigin: Boolean(origin && provider && origin !== provider),
    currentMessageId,
    // Older envelopes supplied their stored provider to channel-owned resolvers.
    transportCurrentMessageId:
      queued.messageIdChannel === undefined && !inboundChannel && sameChannelOrigin && userMessage
        ? queued.messageId
        : currentMessageId,
  };
}
