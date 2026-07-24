// Transcript echo delivery sends best-effort preflight audio transcripts back
// through deliverable message channels.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";

// The message runtime is heavy and only needed when echo delivery actually
// proceeds to a deliverable channel.
const loadMessageRuntime = createLazyRuntimeModule(() => import("../channels/message/runtime.js"));

/**
 * Default operator-visible transcript echo format for preflight audio transcription.
 * Matches the familiar Hermes-style mic glyph so users can skim “what was heard.”
 */
export const DEFAULT_ECHO_TRANSCRIPT_FORMAT = '🎙️ "{transcript}"';

function formatEchoTranscript(transcript: string, format: string): string {
  // Function replacer keeps `$` sequences in the transcript literal instead of
  // being parsed as String.prototype.replace substitution patterns.
  return format.replace("{transcript}", () => transcript);
}

/** Prefer the full provider message id when present (Telegram aliases, etc.). */
function resolveEchoReplyToId(ctx: MsgContext): string | undefined {
  const candidates = [ctx.MessageSidFull, ctx.MessageSid, ctx.MessageSidFirst];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
}

/** Sends a best-effort transcript echo back to the originating deliverable chat. */
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

  const normalizedChannel = normalizeLowercaseStringOrEmpty(channel);
  if (!isDeliverableMessageChannel(normalizedChannel)) {
    if (shouldLogVerbose()) {
      logVerbose(
        `media: echo-transcript skipped (channel "${normalizedChannel}" is not deliverable)`,
      );
    }
    return;
  }

  const text = formatEchoTranscript(transcript, params.format ?? DEFAULT_ECHO_TRANSCRIPT_FORMAT);
  const replyToId = resolveEchoReplyToId(ctx);

  try {
    const { sendDurableMessageBatch } = await loadMessageRuntime();
    const send = await sendDurableMessageBatch({
      cfg,
      channel: normalizedChannel,
      to,
      accountId: ctx.AccountId ?? undefined,
      threadId: ctx.MessageThreadId ?? undefined,
      ...(replyToId ? { replyToId } : {}),
      // Prefer quoting the inbound voice note when the channel supports it so the
      // transcript sits under the audio bubble (Hermes-style review UX).
      payloads: [{ text, ...(replyToId ? { replyToId } : {}) }],
      bestEffort: true,
      durability: "best_effort",
    });
    if (send.status === "failed") {
      throw send.error;
    }
    if (shouldLogVerbose()) {
      logVerbose(`media: echo-transcript sent to ${normalizedChannel}/${to}`);
    }
  } catch (err) {
    logVerbose(`media: echo-transcript delivery failed: ${String(err)}`);
  }
}
