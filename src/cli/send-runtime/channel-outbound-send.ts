import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { loadConfig } from "../../config/config.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

type RuntimeSendOpts = {
  cfg?: ReturnType<typeof loadConfig>;
  mediaUrl?: string;
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
      if (!outbound?.sendText) {
        throw new Error(params.unavailableMessage);
      }
      return await outbound.sendText({
        cfg: opts.cfg ?? loadConfig(),
        to,
        text,
        mediaUrl: opts.mediaUrl,
        mediaLocalRoots: opts.mediaLocalRoots,
        accountId: opts.accountId,
        threadId: opts.messageThreadId,
        replyToId:
          opts.replyToMessageId == null
            ? undefined
            : normalizeOptionalString(String(opts.replyToMessageId)),
        silent: opts.silent,
        forceDocument: opts.forceDocument,
        gifPlayback: opts.gifPlayback,
        gatewayClientScopes: opts.gatewayClientScopes,
      });
    },
  };
}
