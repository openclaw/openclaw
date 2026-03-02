import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";

export const DEFAULT_ECHO_TRANSCRIPT_FORMAT = '📝 "{transcript}"';

function formatEchoTranscript(transcript: string, format: string): string {
  return format.replace("{transcript}", transcript);
}

/**
 * Sends the transcript echo back to the originating chat.
 * Best-effort: logs on failure, never throws.
 */
export async function sendTranscriptEcho(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  transcript: string;
  format?: string;
}): Promise<void> {
  const { ctx, cfg, transcript } = params;
  const channel = ctx.Provider ?? ctx.Surface ?? "";
  const to = ctx.OriginatingTo ?? ctx.From ?? "";

  if (!channel || !to) {
    if (shouldLogVerbose()) {
      logVerbose("media: echo-transcript skipped (no channel/to resolved from ctx)");
    }
    return;
  }

  const normalizedChannel = channel.trim().toLowerCase();
  if (!isDeliverableMessageChannel(normalizedChannel)) {
    if (shouldLogVerbose()) {
      logVerbose(
        `media: echo-transcript skipped (channel "${String(normalizedChannel)}" is not deliverable)`,
      );
    }
    return;
  }

  const text = formatEchoTranscript(transcript, params.format ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT);

  try {
    const { deliverOutboundPayloads } = await import("../infra/outbound/deliver.js");
    await deliverOutboundPayloads({
      cfg,
      channel: normalizedChannel,
      to,
      accountId: ctx.AccountId ?? undefined,
      threadId: ctx.MessageThreadId ?? undefined,
      payloads: [{ text }],
      bestEffort: true,
    });
    if (shouldLogVerbose()) {
      logVerbose(`media: echo-transcript sent to ${normalizedChannel}/${to}`);
    }
  } catch (err) {
    logVerbose(`media: echo-transcript delivery failed: ${String(err)}`);
  }
}
