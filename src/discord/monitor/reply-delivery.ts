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
import type { ThreadBindingManager, ThreadBindingRecord } from "./thread-bindings.js";

function resolveTargetChannelId(target: string): string | undefined {
  if (!target.startsWith("channel:")) {
    return undefined;
  }
  const channelId = target.slice("channel:".length).trim();
  return channelId || undefined;
}

function resolveBoundThreadBinding(params: {
  threadBindings?: ThreadBindingManager;
  sessionKey?: string;
  target: string;
}): ThreadBindingRecord | undefined {
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

function resolveBindingPersona(binding: ThreadBindingRecord | undefined): {
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
  binding?: ThreadBindingRecord;
  username?: string;
  avatarUrl?: string;
}) {
  const text = params.text.trim();
  if (!text) {
    return;
  }
  const binding = params.binding;
  if (binding?.webhookId && binding?.webhookToken) {
    try {
      await sendWebhookMessageDiscord(text, {
        webhookId: binding.webhookId,
        webhookToken: binding.webhookToken,
        accountId: binding.accountId,
        threadId: binding.threadId,
        replyTo: params.replyTo,
        username: params.username,
        avatarUrl: params.avatarUrl,
      });
      return;
    } catch {
      // Fall through to the standard bot sender path.
    }
  }
  await sendMessageDiscord(params.target, text, {
    token: params.token,
    rest: params.rest,
    accountId: params.accountId,
    replyTo: params.replyTo,
  });
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
  threadBindings?: ThreadBindingManager;
}) {
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
  for (const payload of params.replies) {
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
        await sendDiscordChunkWithFallback({
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
      await sendVoiceMessageDiscord(params.target, firstMedia, {
        token: params.token,
        rest: params.rest,
        accountId: params.accountId,
        replyTo,
      });
      // Voice messages cannot include text; send remaining text separately if present.
      await sendDiscordChunkWithFallback({
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
      // Additional media items are sent as regular attachments (voice is single-file only).
      for (const extra of mediaList.slice(1)) {
        const replyTo = resolveReplyTo();
        await sendMessageDiscord(params.target, "", {
          token: params.token,
          rest: params.rest,
          mediaUrl: extra,
          accountId: params.accountId,
          replyTo,
        });
      }
      continue;
    }

    const replyTo = resolveReplyTo();
    await sendMessageDiscord(params.target, text, {
      token: params.token,
      rest: params.rest,
      mediaUrl: firstMedia,
      accountId: params.accountId,
      replyTo,
    });
    for (const extra of mediaList.slice(1)) {
      const replyTo = resolveReplyTo();
      await sendMessageDiscord(params.target, "", {
        token: params.token,
        rest: params.rest,
        mediaUrl: extra,
        accountId: params.accountId,
        replyTo,
      });
    }
  }
}
