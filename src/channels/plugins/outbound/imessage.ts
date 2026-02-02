import type { OpenClawConfig } from "../../../config/config.js";
import { sendMessageIMessage } from "../../../imessage/send.js";
import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import { stripMarkdown } from "../../../line/markdown-to-line.js";
import {
  createScopedChannelMediaMaxBytesResolver,
  createDirectTextMediaOutbound,
} from "./direct-text-media.js";

function resolveIMessageSender(deps: OutboundSendDeps | undefined) {
  return deps?.sendIMessage ?? sendMessageIMessage;
}

function shouldStripMarkdown(cfg: OpenClawConfig, accountId?: string | null): boolean {
  const accountConfig = accountId ? cfg.channels?.imessage?.accounts?.[accountId] : undefined;
  return accountConfig?.markdown?.strip ?? cfg.channels?.imessage?.markdown?.strip ?? false;
}

function maybeStripMarkdown(text: string, cfg: OpenClawConfig, accountId?: string | null): string {
  return shouldStripMarkdown(cfg, accountId) ? stripMarkdown(text) : text;
}

export const imessageOutbound = createDirectTextMediaOutbound({
  channel: "imessage",
  resolveSender: resolveIMessageSender,
  resolveMaxBytes: createScopedChannelMediaMaxBytesResolver("imessage"),
  transformText: maybeStripMarkdown,
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
