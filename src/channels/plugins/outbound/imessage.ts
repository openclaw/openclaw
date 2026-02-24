import { sendMessageIMessage } from "../../../imessage/send.js";
import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import {
  createScopedChannelMediaMaxBytesResolver,
  createDirectTextMediaOutbound,
} from "./direct-text-media.js";

function resolveIMessageSender(deps: OutboundSendDeps | undefined) {
  return deps?.sendIMessage ?? sendMessageIMessage;
}

export const imessageOutbound = createDirectTextMediaOutbound({
  channel: "imessage",
  resolveSender: resolveIMessageSender,
  resolveMaxBytes: createScopedChannelMediaMaxBytesResolver("imessage"),
  buildTextOptions: ({ maxBytes, accountId, replyToId }) => ({
    maxBytes,
    accountId: accountId ?? undefined,
    replyToId: replyToId ?? undefined,
  }),
  buildMediaOptions: ({ mediaUrl, maxBytes, accountId, replyToId, mediaLocalRoots }) => ({
    mediaUrl,
    maxBytes,
    accountId: accountId ?? undefined,
    replyToId: replyToId ?? undefined,
    mediaLocalRoots,
  }),
});
