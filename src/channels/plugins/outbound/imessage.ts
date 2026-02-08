import type { OpenClawConfig } from "../../../config/config.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { chunkText } from "../../../auto-reply/chunk.js";
import { sendMessageIMessage } from "../../../imessage/send.js";
import { stripMarkdown } from "../../../line/markdown-to-line.js";
import { resolveChannelMediaMaxBytes } from "../media-limits.js";

function shouldStripMarkdown(cfg: OpenClawConfig, accountId?: string | null): boolean {
  const accountConfig = accountId ? cfg.channels?.imessage?.accounts?.[accountId] : undefined;
  return accountConfig?.markdown?.strip ?? cfg.channels?.imessage?.markdown?.strip ?? false;
}

function maybeStripMarkdown(
  text: string | undefined,
  cfg: OpenClawConfig,
  accountId?: string | null,
): string | undefined {
  if (!text) return text;
  return shouldStripMarkdown(cfg, accountId) ? stripMarkdown(text) : text;
}

export const imessageOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, deps }) => {
    const send = deps?.sendIMessage ?? sendMessageIMessage;
    const maxBytes = resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.imessage?.accounts?.[accountId]?.mediaMaxMb ??
        cfg.channels?.imessage?.mediaMaxMb,
      accountId,
    });
    const finalText = maybeStripMarkdown(text, cfg, accountId);
    const result = await send(to, finalText ?? text, {
      maxBytes,
      accountId: accountId ?? undefined,
    });
    return { channel: "imessage", ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, accountId, deps }) => {
    const send = deps?.sendIMessage ?? sendMessageIMessage;
    const maxBytes = resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: ({ cfg, accountId }) =>
        cfg.channels?.imessage?.accounts?.[accountId]?.mediaMaxMb ??
        cfg.channels?.imessage?.mediaMaxMb,
      accountId,
    });
    const finalText = maybeStripMarkdown(text, cfg, accountId);
    const result = await send(to, finalText ?? text, {
      mediaUrl,
      maxBytes,
      accountId: accountId ?? undefined,
    });
    return { channel: "imessage", ...result };
  },
};
