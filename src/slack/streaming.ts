/**
 * Slack native text streaming helpers.
 *
 * Uses the Slack SDK's `ChatStreamer` (via `client.chatStream()`) to stream
 * text responses word-by-word in a single updating message, matching Slack's
 * "Agents & AI Apps" streaming UX.
 *
 * @see https://docs.slack.dev/ai/developing-ai-apps#streaming
 * @see https://docs.slack.dev/reference/methods/chat.startStream
 * @see https://docs.slack.dev/reference/methods/chat.appendStream
 * @see https://docs.slack.dev/reference/methods/chat.stopStream
 */

import type { WebClient } from "@slack/web-api";
import type { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";
import { logVerbose } from "../globals.js";
import { normalizeSlackOutboundText } from "./format.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlackStreamSession = {
  /** The SDK ChatStreamer instance managing this stream. */
  streamer: ChatStreamer;
  /** Channel this stream lives in. */
  channel: string;
  /** Thread timestamp (required for streaming). */
  threadTs: string;
  /** True once stop() has been called. */
  stopped: boolean;
  /** Timestamp of the stream message posted by Slack (set after first append). */
  messageTs?: string;
  /** The WebClient used to start this stream (needed for cleanup). */
  client: WebClient;
};

export type StartSlackStreamParams = {
  client: WebClient;
  channel: string;
  threadTs: string;
  /** Optional initial markdown text to include in the stream start. */
  text?: string;
  /**
   * The team ID of the workspace this stream belongs to.
   * Required by the Slack API for `chat.startStream` / `chat.stopStream`.
   * Obtain from `auth.test` response (`team_id`).
   */
  teamId?: string;
  /**
   * The user ID of the message recipient (required for DM streaming).
   * Without this, `chat.stopStream` fails with `missing_recipient_user_id`
   * in direct message conversations.
   */
  userId?: string;
};

export type AppendSlackStreamParams = {
  session: SlackStreamSession;
  text: string;
};

export type StopSlackStreamParams = {
  session: SlackStreamSession;
  /** Optional final markdown text to append before stopping. */
  text?: string;
};

// ---------------------------------------------------------------------------
// Stream lifecycle
// ---------------------------------------------------------------------------

/**
 * Start a new Slack text stream.
 *
 * Returns a {@link SlackStreamSession} that should be passed to
 * {@link appendSlackStream} and {@link stopSlackStream}.
 *
 * The first chunk of text can optionally be included via `text`.
 */
export async function startSlackStream(
  params: StartSlackStreamParams,
): Promise<SlackStreamSession> {
  const { client, channel, threadTs, text, teamId, userId } = params;

  logVerbose(
    `slack-stream: starting stream in ${channel} thread=${threadTs}${teamId ? ` team=${teamId}` : ""}${userId ? ` user=${userId}` : ""}`,
  );

  const streamer = client.chatStream({
    channel,
    thread_ts: threadTs,
    ...(teamId ? { recipient_team_id: teamId } : {}),
    ...(userId ? { recipient_user_id: userId } : {}),
  });

  const session: SlackStreamSession = {
    streamer,
    channel,
    threadTs,
    stopped: false,
    client,
  };

  // If initial text is provided, send it as the first append which will
  // trigger the ChatStreamer to call chat.startStream under the hood.
  if (text) {
    const res = await streamer.append({ markdown_text: normalizeSlackOutboundText(text) });
    if (res && "ts" in res && typeof res.ts === "string") {
      session.messageTs = res.ts;
    }
    logVerbose(`slack-stream: appended initial text (${text.length} chars)`);
  }

  return session;
}

/**
 * Append markdown text to an active Slack stream.
 */
export async function appendSlackStream(params: AppendSlackStreamParams): Promise<void> {
  const { session, text } = params;

  if (session.stopped) {
    logVerbose("slack-stream: attempted to append to a stopped stream, ignoring");
    return;
  }

  if (!text) {
    return;
  }

  await session.streamer.append({ markdown_text: normalizeSlackOutboundText(text) });
  logVerbose(`slack-stream: appended ${text.length} chars`);
}

/**
 * Stop (finalize) a Slack stream.
 *
 * After calling this the stream message becomes a normal Slack message.
 * Optionally include final text to append before stopping.
 */
export async function stopSlackStream(params: StopSlackStreamParams): Promise<void> {
  const { session, text } = params;

  if (session.stopped) {
    logVerbose("slack-stream: stream already stopped, ignoring duplicate stop");
    return;
  }

  session.stopped = true;

  logVerbose(
    `slack-stream: stopping stream in ${session.channel} thread=${session.threadTs}${
      text ? ` (final text: ${text.length} chars)` : ""
    }`,
  );

  const res = await session.streamer.stop(
    text ? { markdown_text: normalizeSlackOutboundText(text) } : undefined,
  );
  if (!session.messageTs && res?.ts) {
    session.messageTs = res.ts;
  }

  logVerbose("slack-stream: stream stopped");
}

/**
 * Abandon a Slack stream by stopping it and deleting the message it posted.
 *
 * Use this when the final reply was suppressed (e.g. NO_REPLY) but streaming
 * already pushed partial text to the channel. Stops the stream first so the
 * message becomes a regular message, then deletes it.
 */
export async function abandonSlackStream(session: SlackStreamSession): Promise<void> {
  // Always attempt to stop, even if a prior stop attempt failed after setting
  // session.stopped = true. Reset the flag so stopSlackStream retries the
  // Slack API call and can capture messageTs if it was missed.
  session.stopped = false;
  try {
    await stopSlackStream({ session });
  } catch {
    // Best-effort; if stop fails we still try to delete.
  }

  const ts = session.messageTs;
  if (!ts) {
    logVerbose("slack-stream: abandon — no messageTs, nothing to delete");
    return;
  }

  logVerbose(`slack-stream: abandoning stream message ${ts} in ${session.channel}`);
  await session.client.chat.delete({ channel: session.channel, ts });
  logVerbose("slack-stream: stream message deleted");
}
