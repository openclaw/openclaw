import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { loadConfig } from "../../config/config.js";

type RuntimeSendOpts = {
  cfg?: ReturnType<typeof loadConfig>;
  mediaUrl?: string;
  mediaUrls?: readonly string[];
  mediaLocalRoots?: readonly string[];
  accountId?: string;
  messageThreadId?: string | number;
  replyToMessageId?: string | number;
  silent?: boolean;
  forceDocument?: boolean;
  gifPlayback?: boolean;
  gatewayClientScopes?: readonly string[];
};

export function createChannelOutboundRuntimeSend(params: {
  channelId: ChannelId;
  unavailableMessage: string;
}) {
  return {
    sendMessage: async (to: string, text: string, opts: RuntimeSendOpts = {}) => {
      const outbound = await loadChannelOutboundAdapter(params.channelId);
      const hasMedia =
        Boolean(opts.mediaUrl) ||
        (Array.isArray(opts.mediaUrls) && opts.mediaUrls.length > 0);
      const sendFn = hasMedia && outbound?.sendMedia ? outbound.sendMedia : outbound?.sendText;
      if (!sendFn) {
        throw new Error(params.unavailableMessage);
      }
      return await sendFn({
        cfg: opts.cfg ?? loadConfig(),
        to,
        text,
        mediaUrl: opts.mediaUrl,
        mediaUrls: opts.mediaUrls,
        mediaLocalRoots: opts.mediaLocalRoots,
        accountId: opts.accountId,
        threadId: opts.messageThreadId,
        replyToId:
          opts.replyToMessageId == null
            ? undefined
            : String(opts.replyToMessageId).trim() || undefined,
        silent: opts.silent,
        forceDocument: opts.forceDocument,
        gifPlayback: opts.gifPlayback,
        gatewayClientScopes: opts.gatewayClientScopes,
      });
    },
  };
}
