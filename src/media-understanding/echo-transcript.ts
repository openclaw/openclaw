// Transcript echo delivery sends best-effort preflight audio transcripts back
// through deliverable message channels.
import { createHash } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";

// The message runtime is heavy and only needed when echo delivery actually
// proceeds to a deliverable channel.
const loadMessageRuntime = createLazyRuntimeModule(() => import("../channels/message/runtime.js"));

/** Default operator-visible transcript echo format for preflight audio transcription. */
export const DEFAULT_ECHO_TRANSCRIPT_FORMAT = '📝 "{transcript}"';

const TELEGRAM_TRANSCRIPT_ECHO_INTENT_PREFIX = "transcript-echo:v1:";
const TELEGRAM_TRANSCRIPT_ECHO_COMPLETION_RETENTION = {
  idPrefix: TELEGRAM_TRANSCRIPT_ECHO_INTENT_PREFIX,
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;

function canonicalizeTelegramChatId(to: string): string | undefined {
  const withoutChannelPrefix = to.trim().replace(/^telegram:/iu, "");
  const withoutTargetKind = withoutChannelPrefix.replace(/^(?:group|user):/iu, "");
  const withoutTopic = withoutTargetKind.replace(/:(?:direct-)?topic:[^:]+$/iu, "");
  const chatId = withoutTopic.trim();
  if (!chatId || /\s/u.test(chatId)) {
    return undefined;
  }
  return chatId.toLowerCase();
}

function buildTelegramTranscriptEchoIntentId(params: {
  accountId?: string;
  to: string;
  messageSid?: string;
}): string | undefined {
  const accountId = params.accountId?.trim();
  const chatId = canonicalizeTelegramChatId(params.to);
  const messageSid = params.messageSid?.trim();
  if (!accountId || !chatId || !messageSid) {
    return undefined;
  }

  const identity = JSON.stringify([accountId, chatId, messageSid]);
  const digest = createHash("sha256").update(identity).digest("hex");
  return `${TELEGRAM_TRANSCRIPT_ECHO_INTENT_PREFIX}${digest}`;
}

function formatEchoTranscript(transcript: string, format: string): string {
  // Function replacer keeps `$` sequences in the transcript literal instead of
  // being parsed as String.prototype.replace substitution patterns.
  return format.replace("{transcript}", () => transcript);
}

/** Sends a best-effort transcript echo back to the originating deliverable chat. */
export async function sendTranscriptEcho(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  transcript: string;
  format?: string;
  logSuccess?: boolean;
  failureLogPrefix?: string;
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
  const deliveryIntentId =
    normalizedChannel === "telegram"
      ? buildTelegramTranscriptEchoIntentId({
          accountId: ctx.AccountId,
          to,
          messageSid: ctx.MessageSid,
        })
      : undefined;

  try {
    const { sendDurableMessageBatchCore } = await loadMessageRuntime();
    const send = await sendDurableMessageBatchCore({
      cfg,
      channel: normalizedChannel,
      to,
      accountId: ctx.AccountId ?? undefined,
      threadId: ctx.MessageThreadId ?? undefined,
      payloads: [{ text }],
      bestEffort: !deliveryIntentId,
      durability: deliveryIntentId ? "required" : "best_effort",
      ...(deliveryIntentId
        ? {
            deliveryIntentId,
            completionRetention: TELEGRAM_TRANSCRIPT_ECHO_COMPLETION_RETENTION,
          }
        : {}),
    });
    if (send.status === "failed") {
      throw send.error;
    }
    if ((params.logSuccess ?? true) && shouldLogVerbose()) {
      logVerbose(`media: echo-transcript sent to ${normalizedChannel}/${to}`);
    }
  } catch (err) {
    const prefix = params.failureLogPrefix ?? "media: echo-transcript delivery failed";
    logVerbose(`${prefix}: ${String(err)}`);
  }
}
