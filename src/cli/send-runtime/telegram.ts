import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import { loadConfig } from "../../config/config.js";

type TelegramRuntimeSendOpts = {
  cfg?: ReturnType<typeof loadConfig>;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string;
  messageThreadId?: string | number;
  replyToMessageId?: string | number;
  silent?: boolean;
  forceDocument?: boolean;
  gatewayClientScopes?: readonly string[];
};

export const runtimeSend = {
  sendMessage: async (to: string, text: string, opts: TelegramRuntimeSendOpts = {}) => {
    const outbound = await loadChannelOutboundAdapter("telegram");
    if (!outbound?.sendText) {
      throw new Error("Telegram outbound adapter is unavailable.");
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
          : String(opts.replyToMessageId).trim() || undefined,
      silent: opts.silent,
      forceDocument: opts.forceDocument,
      gatewayClientScopes: opts.gatewayClientScopes,
    });
  },
};
