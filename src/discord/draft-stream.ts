import type { RequestClient } from "@buape/carbon";
import { Routes } from "discord-api-types/v10";
import { createDraftStreamLoop } from "../channels/draft-stream-loop.js";

/** Discord messages cap at 2000 characters. */
const DISCORD_STREAM_MAX_CHARS = 2000;
const DEFAULT_THROTTLE_MS = 1200;

export type DiscordDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => string | undefined;
  clear: () => Promise<void>;
  stop: () => Promise<void>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
};

export function createDiscordDraftStream(params: {
  rest: RequestClient;
  channelId: string;
  maxChars?: number;
  replyToMessageId?: string | (() => string | undefined);
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): DiscordDraftStream {
  const maxChars = Math.min(params.maxChars ?? DISCORD_STREAM_MAX_CHARS, DISCORD_STREAM_MAX_CHARS);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const channelId = params.channelId;
  const rest = params.rest;
  const resolveReplyToMessageId = () =>
    typeof params.replyToMessageId === "function"
      ? params.replyToMessageId()
      : params.replyToMessageId;

  let streamMessageId: string | undefined;
  let lastSentText = "";
  let stopped = false;
  let isFinal = false;

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    // Allow final flush even if stopped (e.g., after clear()).
    if (stopped && !isFinal) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    if (trimmed.length > maxChars) {
      // Discord messages cap at 2000 chars.
      // Stop streaming once we exceed the cap to avoid repeated API failures.
      stopped = true;
      params.warn?.(`discord stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return false;
    }
    if (trimmed === lastSentText) {
      return true;
    }

    // Debounce first preview send for better push notification quality.
    if (streamMessageId === undefined && minInitialChars != null && !isFinal) {
      if (trimmed.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = trimmed;
    try {
      if (streamMessageId !== undefined) {
        // Edit existing message
        await rest.patch(Routes.channelMessage(channelId, streamMessageId), {
          body: { content: trimmed },
        });
        return true;
      }
      // Send new message
      const replyToMessageId = resolveReplyToMessageId()?.trim();
      const messageReference = replyToMessageId
        ? { message_id: replyToMessageId, fail_if_not_exists: false }
        : undefined;
      const sent = (await rest.post(Routes.channelMessages(channelId), {
        body: {
          content: trimmed,
          ...(messageReference ? { message_reference: messageReference } : {}),
        },
      })) as { id?: string } | undefined;
      const sentMessageId = sent?.id;
      if (typeof sentMessageId !== "string" || !sentMessageId) {
        stopped = true;
        params.warn?.("discord stream preview stopped (missing message id from send)");
        return false;
      }
      streamMessageId = sentMessageId;
      return true;
    } catch (err) {
      stopped = true;
      params.warn?.(
        `discord stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  const loop = createDraftStreamLoop({
    throttleMs,
    isStopped: () => stopped,
    sendOrEditStreamMessage,
  });

  const update = (text: string) => {
    if (stopped || isFinal) {
      return;
    }
    loop.update(text);
  };

  const stop = async (): Promise<void> => {
    isFinal = true;
    await loop.flush();
  };

  const clear = async () => {
    stopped = true;
    loop.stop();
    await loop.waitForInFlight();
    const messageId = streamMessageId;
    streamMessageId = undefined;
    if (typeof messageId !== "string") {
      return;
    }
    try {
      await rest.delete(Routes.channelMessage(channelId, messageId));
    } catch (err) {
      params.warn?.(
        `discord stream preview cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const forceNewMessage = () => {
    streamMessageId = undefined;
    lastSentText = "";
    loop.resetPending();
  };

  params.log?.(`discord stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    clear,
    stop,
    forceNewMessage,
  };
}
