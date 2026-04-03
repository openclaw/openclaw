import { loadChannelOutboundAdapter } from "../../channels/plugins/outbound/load.js";
import { loadConfig } from "../../config/config.js";

type IMessageRuntimeSendOpts = {
  config?: ReturnType<typeof loadConfig>;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string;
  replyToId?: string;
};

export const runtimeSend = {
  sendMessage: async (to: string, text: string, opts: IMessageRuntimeSendOpts = {}) => {
    const outbound = await loadChannelOutboundAdapter("imessage");
    if (!outbound?.sendText) {
      throw new Error("iMessage outbound adapter is unavailable.");
    }
    return await outbound.sendText({
      cfg: opts.config ?? loadConfig(),
      to,
      text,
      mediaUrl: opts.mediaUrl,
      mediaLocalRoots: opts.mediaLocalRoots,
      accountId: opts.accountId,
      replyToId: opts.replyToId,
    });
  },
};
