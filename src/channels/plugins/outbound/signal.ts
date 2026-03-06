import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import { sendMessageSignal } from "../../../signal/send.js";
import {
  createScopedChannelMediaMaxBytesResolver,
  createDirectTextMediaOutbound,
} from "./direct-text-media.js";

function resolveSignalSender(deps: OutboundSendDeps | undefined) {
  return deps?.sendSignal ?? sendMessageSignal;
}

export const signalOutbound = createDirectTextMediaOutbound({
  channel: "signal",
  resolveSender: resolveSignalSender,
  resolveMaxBytes: createScopedChannelMediaMaxBytesResolver("signal"),
  buildTextOptions: ({ cfg, maxBytes, accountId, replyToId, quoteAuthor }) => ({
    cfg,
    maxBytes,
    accountId: accountId ?? undefined,
    replyTo: replyToId ?? undefined,
    quoteAuthor: quoteAuthor ?? undefined,
  }),
  buildMediaOptions: ({
    cfg,
    mediaUrl,
    maxBytes,
    accountId,
    replyToId,
    quoteAuthor,
    mediaLocalRoots,
  }) => ({
    cfg,
    mediaUrl,
    maxBytes,
    accountId: accountId ?? undefined,
    replyTo: replyToId ?? undefined,
    quoteAuthor: quoteAuthor ?? undefined,
    mediaLocalRoots,
  }),
});
