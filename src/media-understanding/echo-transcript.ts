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
 * Unchanged from prior releases so existing `echoTranscript: true` installs keep the
 * same visible output on upgrade.
 */
export const DEFAULT_ECHO_TRANSCRIPT_FORMAT = '📝 "{transcript}"';

function formatEchoTranscript(transcript: string, format: string): string {
  // Function replacer keeps `$` sequences in the transcript literal instead of
  // being parsed as String.prototype.replace substitution patterns.
  return format.replace("{transcript}", () => transcript);
}

/**
 * Prefer the bare inbound message id for shared reply delivery.
 * Prefixed full ids (e.g. `telegram:73299`) fail Telegram's strict integer
 * reply-to normalizer; channel adapters expect the platform-native id.
 */
function resolveEchoReplyToId(ctx: MsgContext): string | undefined {
  const candidates = [ctx.MessageSid, ctx.MessageSidFirst, ctx.MessageSidFull];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (trimmed) {
        // Strip a leading `channel:` prefix if a full id is the only candidate.
        const bare = trimmed.includes(":") ? trimmed.split(":").pop()!.trim() : trimmed;
        if (bare) {
          return bare;
        }
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
  /** Opt-in: quote/reply to the inbound voice note when the channel supports it. */
  reply?: boolean;
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
  // Reply-threading is opt-in so existing enabled echoes keep ordinary send semantics.
  const replyToId = params.reply ? resolveEchoReplyToId(ctx) : undefined;

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
