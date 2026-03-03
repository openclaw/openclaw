import type { RequestClient } from "@buape/carbon";
import { resolveAgentAvatar } from "../../agents/identity-avatar.js";
import type { ChunkMode } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { loadConfig } from "../../config/config.js";
import type { MarkdownTableMode, ReplyToMode } from "../../config/types.base.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import type { RuntimeEnv } from "../../runtime.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { sendMessageDiscord, sendVoiceMessageDiscord, sendWebhookMessageDiscord } from "../send.js";

export type DiscordThreadBindingLookupRecord = {
  accountId: string;
  threadId: string;
  agentId: string;
  label?: string;
  webhookId?: string;
  webhookToken?: string;
};

export type DiscordThreadBindingLookup = {
  listBySessionKey: (targetSessionKey: string) => DiscordThreadBindingLookupRecord[];
  touchThread?: (params: { threadId: string; at?: number; persist?: boolean }) => unknown;
};

function resolveTargetChannelId(target: string): string | undefined {
  if (!target.startsWith("channel:")) {
    return undefined;
  }
  const channelId = target.slice("channel:".length).trim();
  return channelId || undefined;
}

function resolveBoundThreadBinding(params: {
  threadBindings?: DiscordThreadBindingLookup;
  sessionKey?: string;
  target: string;
}): DiscordThreadBindingLookupRecord | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!params.threadBindings || !sessionKey) {
    return undefined;
  }
  const bindings = params.threadBindings.listBySessionKey(sessionKey);
  if (bindings.length === 0) {
    return undefined;
  }
  const targetChannelId = resolveTargetChannelId(params.target);
  if (!targetChannelId) {
    return undefined;
  }
  return bindings.find((entry) => entry.threadId === targetChannelId);
}

function resolveBindingPersona(binding: DiscordThreadBindingLookupRecord | undefined): {
  username?: string;
  avatarUrl?: string;
} {
  if (!binding) {
    return {};
  }
  const baseLabel = binding.label?.trim() || binding.agentId;
  const username = (`🤖 ${baseLabel}`.trim() || "🤖 agent").slice(0, 80);

  let avatarUrl: string | undefined;
  try {
    const avatar = resolveAgentAvatar(loadConfig(), binding.agentId);
    if (avatar.kind === "remote") {
      avatarUrl = avatar.url;
    }
  } catch {
    avatarUrl = undefined;
  }
  return { username, avatarUrl };
}

async function sendDiscordChunkWithFallback(params: {
  target: string;
  text: string;
  token: string;
  accountId?: string;
  rest?: RequestClient;
  replyTo?: string;
  binding?: DiscordThreadBindingLookupRecord;
  username?: string;
  avatarUrl?: string;
}): Promise<{ messageId?: string } | undefined> {
  if (!params.text.trim()) {
    return;
  }
  const text = params.text;
  const binding = params.binding;
  if (binding?.webhookId && binding?.webhookToken) {
    try {
      const sent = await sendWebhookMessageDiscord(text, {
        webhookId: binding.webhookId,
        webhookToken: binding.webhookToken,
        accountId: binding.accountId,
        threadId: binding.threadId,
        replyTo: params.replyTo,
        username: params.username,
        avatarUrl: params.avatarUrl,
      });
      return { messageId: sent.messageId };
    } catch {
      // Fall through to the standard bot sender path.
    }
  }
  const sent = await sendMessageDiscord(params.target, text, {
    token: params.token,
    rest: params.rest,
    accountId: params.accountId,
    replyTo: params.replyTo,
  });
  return { messageId: sent.messageId };
}

async function sendAdditionalDiscordMedia(params: {
  target: string;
  token: string;
  rest?: RequestClient;
  accountId?: string;
  mediaUrls: string[];
  resolveReplyTo: () => string | undefined;
}): Promise<{ messageId?: string }> {
  let lastMessageId: string | undefined;
  for (const mediaUrl of params.mediaUrls) {
    const replyTo = params.resolveReplyTo();
    const sent = await sendMessageDiscord(params.target, "", {
      token: params.token,
      rest: params.rest,
      mediaUrl,
      accountId: params.accountId,
      replyTo,
    });
    if (sent.messageId && sent.messageId !== "unknown") {
      lastMessageId = sent.messageId;
    }
  }
  return { messageId: lastMessageId };
}

export async function deliverDiscordReply(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  rest?: RequestClient;
  runtime: RuntimeEnv;
  textLimit: number;
  maxLinesPerMessage?: number;
  replyToId?: string;
  replyToMode?: ReplyToMode;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  sessionKey?: string;
  threadBindings?: DiscordThreadBindingLookup;
}): Promise<{ delivered: boolean; messageId?: string; deliveredContent?: string }> {
  const chunkLimit = Math.min(params.textLimit, 2000);
  const replyTo = params.replyToId?.trim() || undefined;
  const replyToMode = params.replyToMode ?? "all";
  // replyToMode=first should only apply to the first physical send.
  const replyOnce = replyToMode === "first";
  let replyUsed = false;
  const resolveReplyTo = () => {
    if (!replyTo) {
      return undefined;
    }
    if (!replyOnce) {
      return replyTo;
    }
    if (replyUsed) {
      return undefined;
    }
    replyUsed = true;
    return replyTo;
  };
  const binding = resolveBoundThreadBinding({
    threadBindings: params.threadBindings,
    sessionKey: params.sessionKey,
    target: params.target,
  });
  const persona = resolveBindingPersona(binding);
  let deliveredAny = false;
  let lastMessageId: string | undefined;
  let lastDeliveredContent: string | undefined;
  for (const payload of params.replies) {
    let deliveredThisPayload = false;
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const rawText = payload.text ?? "";
    const tableMode = params.tableMode ?? "code";
    const text = convertMarkdownTables(rawText, tableMode);
    if (!text && mediaList.length === 0) {
      continue;
    }
    if (mediaList.length === 0) {
      const mode = params.chunkMode ?? "length";
      const chunks = chunkDiscordTextWithMode(text, {
        maxChars: chunkLimit,
        maxLines: params.maxLinesPerMessage,
        chunkMode: mode,
      });
      if (!chunks.length && text) {
        chunks.push(text);
      }
      for (const chunk of chunks) {
        if (!chunk.trim()) {
          continue;
        }
        const replyTo = resolveReplyTo();
        const sent = await sendDiscordChunkWithFallback({
          target: params.target,
          text: chunk,
          token: params.token,
          rest: params.rest,
          accountId: params.accountId,
          replyTo,
          binding,
          username: persona.username,
          avatarUrl: persona.avatarUrl,
        });
        deliveredAny = true;
        deliveredThisPayload = true;
        if (sent?.messageId && sent.messageId !== "unknown") {
          lastMessageId = sent.messageId;
        }
      }
      if (deliveredThisPayload) {
        lastDeliveredContent = text;
      }
      continue;
    }

    const firstMedia = mediaList[0];
    if (!firstMedia) {
      continue;
    }

    // Voice message path: audioAsVoice flag routes through sendVoiceMessageDiscord.
    if (payload.audioAsVoice) {
      const replyTo = resolveReplyTo();
      const sent = await sendVoiceMessageDiscord(params.target, firstMedia, {
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        replyTo,
      });
      deliveredAny = true;
      deliveredThisPayload = true;
      if (sent.messageId && sent.messageId !== "unknown") {
        lastMessageId = sent.messageId;
      }
      // Voice messages cannot include text; send remaining text separately if present.
      const textSent = await sendDiscordChunkWithFallback({
        target: params.target,
        text,
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        replyTo: resolveReplyTo(),
        binding,
        username: persona.username,
        avatarUrl: persona.avatarUrl,
      });
      if (textSent?.messageId && textSent.messageId !== "unknown") {
        lastMessageId = textSent.messageId;
      }
      // Additional media items are sent as regular attachments (voice is single-file only).
      const additionalMedia = await sendAdditionalDiscordMedia({
        target: params.target,
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        mediaUrls: mediaList.slice(1),
        resolveReplyTo,
      });
      if (additionalMedia.messageId) {
        lastMessageId = additionalMedia.messageId;
      }
      lastDeliveredContent = text;
      continue;
    }

    const replyTo = resolveReplyTo();
    const sent = await sendMessageDiscord(params.target, text, {
      token: params.token,
      rest: params.rest,
      mediaUrl: firstMedia,
      accountId: params.accountId,
      replyTo,
    });
    deliveredAny = true;
    deliveredThisPayload = true;
    if (sent.messageId && sent.messageId !== "unknown") {
      lastMessageId = sent.messageId;
    }
    const additionalMedia = await sendAdditionalDiscordMedia({
      target: params.target,
      token: params.token,
      rest: params.rest,
      accountId: params.accountId,
      mediaUrls: mediaList.slice(1),
      resolveReplyTo,
    });
    if (additionalMedia.messageId) {
      lastMessageId = additionalMedia.messageId;
    }
    if (deliveredThisPayload) {
      lastDeliveredContent = text;
    }
  }

  if (binding && deliveredAny) {
    params.threadBindings?.touchThread?.({ threadId: binding.threadId });
  }
  return {
    delivered: deliveredAny,
    ...(lastMessageId ? { messageId: lastMessageId } : {}),
    ...(lastDeliveredContent !== undefined ? { deliveredContent: lastDeliveredContent } : {}),
  };
}
