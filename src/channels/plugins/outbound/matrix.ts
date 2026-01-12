import { chunkMarkdownText } from "../../../auto-reply/chunk.js";
import { sendMessageMatrix } from "../../../matrix/send.js";
import type { ChannelOutboundAdapter } from "../types.js";

export const matrixOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkMarkdownText,
  textChunkLimit: 4000,
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim();
    if (!trimmed) {
      return {
        ok: false,
        error: new Error(
          "Delivering to Matrix requires --to <room:ID|#alias|@user:server>",
        ),
      };
    }
    return { ok: true, to: trimmed };
  },
  sendText: async ({ to, text, deps, replyToId, threadId }) => {
    const send = deps?.sendMatrix ?? sendMessageMatrix;
    const resolvedThreadId =
      typeof threadId === "number" ? String(threadId) : threadId;
    const opts =
      replyToId || resolvedThreadId
        ? { replyToId: replyToId ?? undefined, threadId: resolvedThreadId }
        : undefined;
    const result = opts ? await send(to, text, opts) : await send(to, text);
    return { channel: "matrix", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, deps, replyToId, threadId }) => {
    const send = deps?.sendMatrix ?? sendMessageMatrix;
    const resolvedThreadId =
      typeof threadId === "number" ? String(threadId) : threadId;
    const opts = {
      mediaUrl,
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
    };
    const result = await send(to, text, opts);
    return { channel: "matrix", ...result };
  },
};
