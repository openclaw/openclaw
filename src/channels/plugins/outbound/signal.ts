import { resolveOutboundSendDep, type OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import { sendMessageSignal } from "../../../signal/send.js";
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
  buildTextOptions: ({ cfg, maxBytes, accountId }) => ({
    cfg,
    maxBytes,
    accountId: accountId ?? undefined,
  }),
  buildMediaOptions: ({ cfg, mediaUrl, maxBytes, accountId, mediaLocalRoots }) => ({
    cfg,
    mediaUrl,
    maxBytes,
    accountId: accountId ?? undefined,
    mediaLocalRoots,
  }),
});
