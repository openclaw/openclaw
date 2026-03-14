import { sendMessageSignal } from "../../../../extensions/signal/src/send.js";
import { resolveOutboundSendDep, type OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import {
  createScopedChannelMediaMaxBytesResolver,
  createDirectTextMediaOutbound,
} from "./direct-text-media.js";

function resolveSignalSender(deps: OutboundSendDeps | undefined) {
  return resolveOutboundSendDep<typeof sendMessageSignal>(deps, "signal") ?? sendMessageSignal;
}

export const signalOutbound = createDirectTextMediaOutbound({
  channel: "signal",
  resolveSender: resolveSignalSender,
  resolveMaxBytes: createScopedChannelMediaMaxBytesResolver("signal"),
  buildTextOptions: ({ cfg, maxBytes, accountId, replyToId }) => ({
    cfg,
    maxBytes,
    accountId: accountId ?? undefined,
    replyTo: replyToId ?? undefined,
  }),
  buildMediaOptions: ({ cfg, mediaUrl, maxBytes, accountId, mediaLocalRoots, replyToId }) => ({
    cfg,
    mediaUrl,
    maxBytes,
    accountId: accountId ?? undefined,
    mediaLocalRoots,
    replyTo: replyToId ?? undefined,
  }),
});
