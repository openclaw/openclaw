import { createDraftStreamLoop } from "../channels/draft-stream-loop.js";
import { deleteSlackMessage, editSlackMessage } from "./actions.js";
import { sendMessageSlack } from "./send.js";

const SLACK_STREAM_MAX_CHARS = 4000;
const DEFAULT_THROTTLE_MS = 1000;

export type SlackDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  clear: () => Promise<void>;
  stop: () => void;
  forceNewMessage: () => void;
  messageId: () => string | undefined;
  channelId: () => string | undefined;
};

export function createSlackDraftStream(params: {
  target: string;
  token: string;
  accountId?: string;
  maxChars?: number;
  throttleMs?: number;
  resolveThreadTs?: () => string | undefined;
  onMessageSent?: () => void;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  send?: typeof sendMessageSlack;
  edit?: typeof editSlackMessage;
  remove?: typeof deleteSlackMessage;
}): SlackDraftStream {
  const maxChars = Math.min(params.maxChars ?? SLACK_STREAM_MAX_CHARS, SLACK_STREAM_MAX_CHARS);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const send = params.send ?? sendMessageSlack;
  const edit = params.edit ?? editSlackMessage;
  const remove = params.remove ?? deleteSlackMessage;

  let streamMessageId: string | undefined;
  let streamChannelId: string | undefined;
  let lastSentText = "";
  let stopped = false;

  const sendOrEditStreamMessage = async (text: string) => {
    if (stopped) {
      return;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return;
    }
    if (trimmed.length > maxChars) {
      stopped = true;
      params.warn?.(`slack stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return;
    }
    if (trimmed === lastSentText) {
      return;
    }
    lastSentText = trimmed;
    try {
      if (streamChannelId && streamMessageId) {
        await edit(streamChannelId, streamMessageId, trimmed, {
          token: params.token,
          accountId: params.accountId,
        });
        return;
      }
      const sent = await send(params.target, trimmed, {
        token: params.token,
        accountId: params.accountId,
        threadTs: params.resolveThreadTs?.(),
      });
      streamChannelId = sent.channelId || streamChannelId;
      streamMessageId = sent.messageId || streamMessageId;
      if (!streamChannelId || !streamMessageId) {
        stopped = true;
        params.warn?.("slack stream preview stopped (missing identifiers from sendMessage)");
        return;
      }
      params.onMessageSent?.();
    } catch (err) {
      stopped = true;
      params.warn?.(
        `slack stream preview failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const loop = createDraftStreamLoop({
    throttleMs,
    isStopped: () => stopped,
    sendOrEditStreamMessage,
  });

  const stop = () => {
    stopped = true;
    loop.stop();
  };

  const clear = async () => {
    stop();
    await loop.waitForInFlight();
    const channelId = streamChannelId;
    const messageId = streamMessageId;
    streamChannelId = undefined;
    streamMessageId = undefined;
    lastSentText = "";
    if (!channelId || !messageId) {
      return;
    }
    try {
      await remove(channelId, messageId, {
        token: params.token,
        accountId: params.accountId,
      });
    } catch (err) {
      params.warn?.(
        `slack stream preview cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const forceNewMessage = () => {
    streamMessageId = undefined;
    streamChannelId = undefined;
    lastSentText = "";
    loop.resetPending();
  };

  params.log?.(`slack stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update: loop.update,
    flush: loop.flush,
    clear,
    stop,
    forceNewMessage,
    messageId: () => streamMessageId,
    channelId: () => streamChannelId,
  };
}
