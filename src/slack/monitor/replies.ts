import type { ChunkMode } from "../../auto-reply/chunk.js";
import { chunkMarkdownTextWithMode } from "../../auto-reply/chunk.js";
import { createReplyReferencePlanner } from "../../auto-reply/reply/reply-reference.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { RuntimeEnv } from "../../runtime.js";
import { markdownToSlackMrkdwnChunks } from "../format.js";
import { sendMessageSlack, type SlackSendIdentity } from "../send.js";
import { parseSlackTarget } from "../targets.js";

function resolveSlackHookChannelId(target: string): string | undefined {
  try {
    const parsedTarget = parseSlackTarget(target, { defaultKind: "channel" });
    return parsedTarget?.kind === "channel" ? parsedTarget.id : undefined;
  } catch {
    return undefined;
  }
}

async function applySlackMessageSendingHooks(params: {
  target: string;
  text: string;
  threadTs?: string;
  accountId?: string;
  mediaUrl?: string;
}): Promise<{ cancelled: boolean; text: string }> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sending")) {
    return { cancelled: false, text: params.text };
  }
  const hookChannelId = resolveSlackHookChannelId(params.target);
  const hookResult = await hookRunner.runMessageSending(
    {
      to: params.target,
      content: params.text,
      metadata: {
        threadTs: params.threadTs,
        ...(hookChannelId ? { channelId: hookChannelId } : {}),
        ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
      },
    },
    { channelId: "slack", accountId: params.accountId ?? undefined },
  );
  if (hookResult?.cancel) {
    return { cancelled: true, text: params.text };
  }
  return { cancelled: false, text: hookResult?.content ?? params.text };
}

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  mediaLocalRoots?: readonly string[];
  runtime: RuntimeEnv;
  textLimit: number;
  replyThreadTs?: string;
  replyToMode: "off" | "first" | "all";
  identity?: SlackSendIdentity;
}) {
  let deliveredCount = 0;
  for (const payload of params.replies) {
    // Keep reply tags opt-in: when replyToMode is off, explicit reply tags
    // must not force threading.
    const inlineReplyToId = params.replyToMode === "off" ? undefined : payload.replyToId;
    const threadTs = inlineReplyToId ?? params.replyThreadTs;
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const rawText = payload.text ?? "";
    if (!rawText && mediaList.length === 0) {
      continue;
    }
    const hookResult = await applySlackMessageSendingHooks({
      target: params.target,
      text: rawText,
      threadTs,
      accountId: params.accountId,
      mediaUrl: mediaList[0],
    });
    if (hookResult.cancelled) {
      continue;
    }
    const text = hookResult.text;
    const trimmed = text.trim();
    const isSilentText = isSilentReplyText(trimmed, SILENT_REPLY_TOKEN);

    if (mediaList.length === 0) {
      if (!trimmed || isSilentText) {
        continue;
      }
      await sendMessageSlack(params.target, trimmed, {
        token: params.token,
        threadTs,
        accountId: params.accountId,
        mediaLocalRoots: params.mediaLocalRoots,
        ...(params.identity ? { identity: params.identity } : {}),
      });
      deliveredCount += 1;
    } else {
      let first = true;
      for (const mediaUrl of mediaList) {
        const caption = first && !isSilentText ? text : "";
        first = false;
        await sendMessageSlack(params.target, caption, {
          token: params.token,
          mediaUrl,
          threadTs,
          accountId: params.accountId,
          mediaLocalRoots: params.mediaLocalRoots,
          ...(params.identity ? { identity: params.identity } : {}),
        });
        deliveredCount += 1;
      }
    }
    params.runtime.log?.(`delivered reply to ${params.target}`);
  }
  return deliveredCount;
}

export type SlackRespondFn = (payload: {
  text: string;
  response_type?: "ephemeral" | "in_channel";
}) => Promise<unknown>;

/**
 * Compute effective threadTs for a Slack reply based on replyToMode.
 * - "off": stay in thread if already in one, otherwise main channel
 * - "first": first reply goes to thread, subsequent replies to main channel
 * - "all": all replies go to thread
 */
export function resolveSlackThreadTs(params: {
  replyToMode: "off" | "first" | "all";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasReplied: boolean;
  isThreadReply?: boolean;
}): string | undefined {
  const planner = createSlackReplyReferencePlanner({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: params.hasReplied,
    isThreadReply: params.isThreadReply,
  });
  return planner.use();
}

type SlackReplyDeliveryPlan = {
  nextThreadTs: () => string | undefined;
  markSent: () => void;
};

function createSlackReplyReferencePlanner(params: {
  replyToMode: "off" | "first" | "all";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasReplied?: boolean;
  isThreadReply?: boolean;
}) {
  // Keep backward-compatible behavior: when a thread id is present and caller
  // does not provide explicit classification, stay in thread. Callers that can
  // distinguish Slack's auto-populated top-level thread_ts should pass
  // `isThreadReply: false` to preserve replyToMode behavior.
  const effectiveIsThreadReply = params.isThreadReply ?? Boolean(params.incomingThreadTs);
  const effectiveMode = effectiveIsThreadReply ? "all" : params.replyToMode;
  return createReplyReferencePlanner({
    replyToMode: effectiveMode,
    existingId: params.incomingThreadTs,
    startId: params.messageTs,
    hasReplied: params.hasReplied,
  });
}

export function createSlackReplyDeliveryPlan(params: {
  replyToMode: "off" | "first" | "all";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  hasRepliedRef: { value: boolean };
  isThreadReply?: boolean;
}): SlackReplyDeliveryPlan {
  const replyReference = createSlackReplyReferencePlanner({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: params.hasRepliedRef.value,
    isThreadReply: params.isThreadReply,
  });
  return {
    nextThreadTs: () => replyReference.use(),
    markSent: () => {
      replyReference.markSent();
      params.hasRepliedRef.value = replyReference.hasReplied();
    },
  };
}

export async function deliverSlackSlashReplies(params: {
  replies: ReplyPayload[];
  respond: SlackRespondFn;
  ephemeral: boolean;
  textLimit: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
}) {
  const messages: string[] = [];
  const chunkLimit = Math.min(params.textLimit, 4000);
  for (const payload of params.replies) {
    const textRaw = payload.text?.trim() ?? "";
    const text = textRaw && !isSilentReplyText(textRaw, SILENT_REPLY_TOKEN) ? textRaw : undefined;
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const combined = [text ?? "", ...mediaList.map((url) => url.trim()).filter(Boolean)]
      .filter(Boolean)
      .join("\n");
    if (!combined) {
      continue;
    }
    const chunkMode = params.chunkMode ?? "length";
    const markdownChunks =
      chunkMode === "newline"
        ? chunkMarkdownTextWithMode(combined, chunkLimit, chunkMode)
        : [combined];
    const chunks = markdownChunks.flatMap((markdown) =>
      markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode: params.tableMode }),
    );
    if (!chunks.length && combined) {
      chunks.push(combined);
    }
    for (const chunk of chunks) {
      messages.push(chunk);
    }
  }

  if (messages.length === 0) {
    return;
  }

  // Slack slash command responses can be multi-part by sending follow-ups via response_url.
  const responseType = params.ephemeral ? "ephemeral" : "in_channel";
  for (const text of messages) {
    await params.respond({ text, response_type: responseType });
  }
}
