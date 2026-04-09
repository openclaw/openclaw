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
      const commonCtx = {
        cfg: opts.cfg ?? loadConfig(),
        to,
        text,
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
      };

      // Route to sendMedia when a media URL is provided and the adapter supports it.
      // Without this, media payloads are silently dropped because sendText ignores mediaUrl.
      if (opts.mediaUrl && outbound.sendMedia) {
        return await outbound.sendMedia({
          ...commonCtx,
          mediaUrl: opts.mediaUrl,
          mediaLocalRoots: opts.mediaLocalRoots,
        });
      }

      return await outbound.sendText({
        ...commonCtx,
        mediaLocalRoots: opts.mediaLocalRoots,
      });
    },
  };
}
