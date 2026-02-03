import type { ChannelOutboundAdapter } from "../types.js";
import { chunkText } from "../../../auto-reply/chunk.js";
import { parseSignalQuoteParams } from "../../../signal/quote-params.js";
import { sendMessageSignal } from "../../../signal/send.js";
import { resolveChannelMediaMaxBytes } from "../media-limits.js";

export const signalOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId }) => {
    const send = deps?.sendSignal ?? sendMessageSignal;
    const maxBytes = resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.signal?.mediaMaxMb,
      accountId,
    });
    const quoteParams = parseSignalQuoteParams(to, replyToId);
    const result = await send(to, text, {
      maxBytes,
      accountId: accountId ?? undefined,
      ...quoteParams,
    });
    return { channel: "signal", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps, replyToId }) => {
    const send = deps?.sendSignal ?? sendMessageSignal;
    const maxBytes = resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.signal?.mediaMaxMb,
      accountId,
    });
    const quoteParams = parseSignalQuoteParams(to, replyToId);
    const result = await send(to, text, {
      mediaUrl,
      maxBytes,
      accountId: accountId ?? undefined,
      ...quoteParams,
    });
    return { channel: "signal", ...result };
  },
};
