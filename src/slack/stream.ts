import type { WebClient } from "@slack/web-api";
import { logVerbose } from "../globals.js";

export type SlackStreamHandle = {
  /** Append markdown text to the live-updating message. */
  append: (text: string) => Promise<void>;
  /** Finalize the stream. The message becomes a normal Slack message. */
  stop: () => Promise<void>;
};

/** Minimum ms between stream appends to create a visible reveal effect. */
const STREAM_CHUNK_DELAY_MS = 100;
/** Approximate characters per streaming chunk. */
const STREAM_CHUNK_SIZE = 40;

/**
 * Split `text` into chunks that break on word boundaries.
 */
function chunkText(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= chunkSize) {
      chunks.push(remaining);
      break;
    }
    let end = remaining.lastIndexOf(" ", chunkSize);
    if (end <= 0) {
      end = remaining.indexOf(" ", chunkSize);
      if (end <= 0) end = remaining.length;
    }
    chunks.push(remaining.slice(0, end + 1));
    remaining = remaining.slice(end + 1);
  }
  return chunks;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Start a Slack streaming message using `chat.startStream` /
 * `chat.appendStream` / `chat.stopStream`.
 *
 * The API returns a message `ts` which is used with the channel to
 * identify the stream for append/stop calls.  Each append sends the
 * full cumulative text as `markdown_text`.
 */
export async function startSlackStream(params: {
  client: WebClient;
  channel: string;
  threadTs?: string;
}): Promise<SlackStreamHandle> {
  const { client, channel, threadTs } = params;

  const startPayload: Record<string, unknown> = { channel };
  if (threadTs) {
    startPayload.thread_ts = threadTs;
  }

  const startResult = (await client.apiCall("chat.startStream", startPayload)) as {
    ok?: boolean;
    ts?: string;
    stream_id?: string;
    channel?: string;
    error?: string;
  };

  if (!startResult.ok) {
    throw new Error(`chat.startStream failed: ${startResult.error ?? "unknown error"}`);
  }

  const streamId = startResult.stream_id ?? startResult.ts;
  if (!streamId) {
    throw new Error("chat.startStream returned neither stream_id nor ts");
  }

  const streamChannel = startResult.channel ?? channel;
  let appendCount = 0;
  let cumulativeText = "";

  const rawAppend = async (text: string) => {
    appendCount++;
    cumulativeText += text;
    const result = (await client.apiCall("chat.appendStream", {
      channel: streamChannel,
      ts: streamId,
      markdown_text: cumulativeText,
    })) as { ok?: boolean; error?: string };
    if (!result.ok) {
      throw new Error(`chat.appendStream failed: ${result.error}`);
    }
  };

  const rawStop = async () => {
    await client.apiCall("chat.stopStream", {
      channel: streamChannel,
      ts: streamId,
    });
  };

  const chunkedAppend = async (text: string) => {
    const chunks = chunkText(text, STREAM_CHUNK_SIZE);
    for (let i = 0; i < chunks.length; i++) {
      await rawAppend(chunks[i]);
      if (i < chunks.length - 1) {
        await sleep(STREAM_CHUNK_DELAY_MS);
      }
    }
  };

  return {
    append: chunkedAppend,
    stop: rawStop,
  };
}

/**
 * Deliver a complete message via streaming.  Falls back to returning
 * `false` if the stream API is unavailable.
 */
export async function deliverViaStream(params: {
  client: WebClient;
  channel: string;
  text: string;
  threadTs?: string;
}): Promise<boolean> {
  try {
    const stream = await startSlackStream({
      client: params.client,
      channel: params.channel,
      threadTs: params.threadTs,
    });
    await stream.append(params.text);
    await stream.stop();
    return true;
  } catch (err) {
    logVerbose(`slack stream delivery failed, will fall back: ${String(err)}`);
    return false;
  }
}
