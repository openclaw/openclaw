import type { ChunkMode } from "../../auto-reply/chunk.js";
import { chunkMarkdownTextWithMode } from "../../auto-reply/chunk.js";
import { createReplyReferencePlanner } from "../../auto-reply/reply/reply-reference.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { MarkdownTableMode } from "../../config/types.base.js";
import type { RuntimeEnv } from "../../runtime.js";
import { markdownToSlackMrkdwnChunks } from "../format.js";
import { sendMessageSlack } from "../send.js";

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  runtime: RuntimeEnv;
  textLimit: number;
  replyThreadTs?: string;
  replyToMode: "off" | "first" | "all";
}) {
  for (const payload of params.replies) {
    // Keep reply tags opt-in: when replyToMode is off, explicit reply tags
    // must not force threading.
    const inlineReplyToId = params.replyToMode === "off" ? undefined : payload.replyToId;
    const threadTs = inlineReplyToId ?? params.replyThreadTs;
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) {
      continue;
    }

    if (mediaList.length === 0) {
      const trimmed = text.trim();
      if (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN)) {
        continue;
      }
      await sendMessageSlack(params.target, trimmed, {
        token: params.token,
        threadTs,
        accountId: params.accountId,
      });
    } else {
      let first = true;
      for (const mediaUrl of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageSlack(params.target, caption, {
          token: params.token,
          mediaUrl,
          threadTs,
          accountId: params.accountId,
        });
      }
    }
    params.runtime.log?.(`delivered reply to ${params.target}`);
  }
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
