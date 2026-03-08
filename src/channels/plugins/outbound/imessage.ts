import { sendMessageIMessage } from "../../../imessage/send.js";
import type { OutboundSendDeps } from "../../../infra/outbound/deliver.js";
import type { ChannelOutboundAdapter } from "../types.js";
import { createScopedChannelMediaMaxBytesResolver } from "./direct-text-media.js";

function resolveIMessageSender(deps: OutboundSendDeps | undefined) {
  return deps?.sendIMessage ?? sendMessageIMessage;
}

export const imessageOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  chunkerMode: "text",
  textChunkLimit: 4000,
  sendText: async ({ cfg, to, text, accountId, deps, replyToId }) => {
    const send = resolveIMessageSender(deps);
    const maxBytes = createScopedChannelMediaMaxBytesResolver("imessage")({
      cfg,
      accountId,
    });
    const result = await send(to, text, {
      config: cfg,
      maxBytes,
      accountId: accountId ?? undefined,
      replyToId: replyToId ?? undefined,
    });
    return { channel: "imessage" as const, ...result };
  },
  sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps, replyToId }) => {
    const send = resolveIMessageSender(deps);
    const maxBytes = createScopedChannelMediaMaxBytesResolver("imessage")({
      cfg,
      accountId,
    });
    const result = await send(to, text, {
      config: cfg,
      mediaUrl,
      maxBytes,
      accountId: accountId ?? undefined,
      replyToId: replyToId ?? undefined,
      mediaLocalRoots,
    });
    return { channel: "imessage" as const, ...result };
  },
  sendPayload: async ({ cfg, to, payload, mediaLocalRoots, accountId, deps, replyToId }) => {
    const send = resolveIMessageSender(deps);
    const maxBytes = createScopedChannelMediaMaxBytesResolver("imessage")({
      cfg,
      accountId,
    });
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];
    const text = payload.text ?? "";

    if (!payload.audioAsVoice || mediaUrls.length === 0) {
      if (mediaUrls.length === 0) {
        const result = await send(to, text, {
          config: cfg,
          maxBytes,
          accountId: accountId ?? undefined,
          replyToId: replyToId ?? undefined,
        });
        return { channel: "imessage" as const, ...result };
      }
      let finalResult: Awaited<ReturnType<ReturnType<typeof resolveIMessageSender>>> | undefined;
      for (let index = 0; index < mediaUrls.length; index += 1) {
        finalResult = await send(to, index === 0 ? text : "", {
          config: cfg,
          mediaUrl: mediaUrls[index],
          maxBytes,
          accountId: accountId ?? undefined,
          replyToId: replyToId ?? undefined,
          mediaLocalRoots,
        });
      }
      return { channel: "imessage" as const, ...(finalResult ?? { messageId: "unknown" }) };
    }

    let finalResult = await send(to, "", {
      config: cfg,
      mediaUrl: mediaUrls[0],
      maxBytes,
      accountId: accountId ?? undefined,
      replyToId: replyToId ?? undefined,
      mediaLocalRoots,
      audioAsVoice: true,
    });
    if (text.trim()) {
      finalResult = await send(to, text, {
        config: cfg,
        maxBytes,
        accountId: accountId ?? undefined,
        replyToId: replyToId ?? undefined,
      });
    }
    for (const mediaUrl of mediaUrls.slice(1)) {
      finalResult = await send(to, "", {
        config: cfg,
        mediaUrl,
        maxBytes,
        accountId: accountId ?? undefined,
        replyToId: replyToId ?? undefined,
        mediaLocalRoots,
      });
    }
    return { channel: "imessage" as const, ...finalResult };
  },
};
