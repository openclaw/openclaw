import { signalOutbound } from "../../../extensions/signal/test-api.js";
import { telegramOutbound } from "../../../extensions/telegram/test-api.js";
import { whatsappOutbound } from "../../../extensions/whatsapp/test-api.js";
import {
  createDirectTextMediaOutbound,
  createScopedChannelMediaMaxBytesResolver,
} from "../../plugin-sdk/media-runtime.js";
import { resolveOutboundSendDep, type OutboundSendDeps } from "./send-deps.js";

export { signalOutbound, telegramOutbound, whatsappOutbound };

function resolveIMessageSender(deps: OutboundSendDeps | undefined) {
  const sender = resolveOutboundSendDep<
    (
      to: string,
      text: string,
      options?: Record<string, unknown>,
    ) => Promise<{ messageId: string; chatId?: string }>
  >(deps, "imessage");
  if (!sender) {
    throw new Error("missing sendIMessage dep");
  }
  return sender;
}

export const imessageOutboundForTest = createDirectTextMediaOutbound({
  channel: "imessage",
  resolveSender: resolveIMessageSender,
  resolveMaxBytes: createScopedChannelMediaMaxBytesResolver("imessage"),
  buildTextOptions: ({ cfg, maxBytes, accountId, replyToId }) => ({
    config: cfg,
    maxBytes,
    accountId: accountId ?? undefined,
    replyToId: replyToId ?? undefined,
  }),
  buildMediaOptions: ({ cfg, mediaUrl, maxBytes, accountId, replyToId, mediaLocalRoots }) => ({
    config: cfg,
    mediaUrl,
    maxBytes,
    accountId: accountId ?? undefined,
    replyToId: replyToId ?? undefined,
    mediaLocalRoots,
  }),
});
