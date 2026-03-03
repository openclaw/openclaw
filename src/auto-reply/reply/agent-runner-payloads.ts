import type { ErrorPolicy } from "../../config/types.channels.js";
import type { ReplyToMode } from "../../config/types.js";
import { logVerbose } from "../../globals.js";
import { stripHeartbeatToken } from "../heartbeat.js";
import type { OriginatingChannelType } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";
import { formatBunFetchSocketError, isBunFetchSocketError } from "./agent-runner-utils.js";
import { createBlockReplyPayloadKey, type BlockReplyPipeline } from "./block-reply-pipeline.js";
import {
  resolveOriginAccountId,
  resolveOriginMessageProvider,
  resolveOriginMessageTo,
} from "./origin-routing.js";
import { normalizeReplyPayloadDirectives } from "./reply-delivery.js";
import {
  applyReplyThreading,
  filterMessagingToolDuplicates,
  filterMessagingToolMediaDuplicates,
  isRenderablePayload,
  shouldSuppressMessagingToolReplies,
} from "./reply-payloads.js";

export function buildReplyPayloads(params: {
  payloads: ReplyPayload[];
  isHeartbeat: boolean;
  didLogHeartbeatStrip: boolean;
  blockStreamingEnabled: boolean;
  blockReplyPipeline: BlockReplyPipeline | null;
  /** Payload keys sent directly (not via pipeline) during tool flush. */
  directlySentBlockKeys?: Set<string>;
  replyToMode: ReplyToMode;
  replyToChannel?: OriginatingChannelType;
  currentMessageId?: string;
  messageProvider?: string;
  messagingToolSentTexts?: string[];
  messagingToolSentMediaUrls?: string[];
  messagingToolSentTargets?: Parameters<
    typeof shouldSuppressMessagingToolReplies
  >[0]["messagingToolSentTargets"];
  originatingChannel?: OriginatingChannelType;
  originatingTo?: string;
  accountId?: string;
  /** How to handle error payloads (reply | silent | react-only). */
  errorPolicy?: ErrorPolicy;
}): {
  replyPayloads: ReplyPayload[];
  didLogHeartbeatStrip: boolean;
  errorReactionRequested?: boolean;
} {
  let didLogHeartbeatStrip = params.didLogHeartbeatStrip;
  let errorReactionRequested = false;

  // Helper: check if error is transient (rate limit, overloaded, timeout)
  // vs actionable recovery messages (context overflow, session reset)
  const isTransientApiError = (payload: ReplyPayload): boolean => {
    if (!payload.isError) {
      return false;
    }
    const text = payload.text?.toLowerCase() || "";
    // Transient errors that should be suppressed
    return (
      text.includes("rate limit") ||
      text.includes("overloaded") ||
      text.includes("timeout") ||
      text.includes("api error") ||
      text.includes("429") ||
      text.includes("503") ||
      text.includes("socket connection was closed") // Bun transport failure
    );
  };

  // Apply errorPolicy filtering (skip for heartbeat to preserve alerts)
  // For react-only on non-Discord channels, fall back to silent (no reaction support)
  // Only filter transient API errors, not actionable recovery messages
  const supportsReaction = params.originatingChannel === "discord";
  const effectiveErrorPolicy =
    params.errorPolicy === "react-only" && !supportsReaction ? "silent" : params.errorPolicy;

  const errorFilteredPayloads =
    params.isHeartbeat || !effectiveErrorPolicy
      ? params.payloads
      : effectiveErrorPolicy === "silent"
        ? params.payloads.filter((payload) => !isTransientApiError(payload))
        : effectiveErrorPolicy === "react-only"
          ? params.payloads
              .map((payload) => {
                if (isTransientApiError(payload)) {
                  errorReactionRequested = true;
                  return null;
                }
                return payload;
              })
              .filter((p): p is ReplyPayload => p !== null)
          : params.payloads;

  const sanitizedPayloads = params.isHeartbeat
    ? errorFilteredPayloads
    : errorFilteredPayloads.flatMap((payload) => {
        let text = payload.text;

        if (payload.isError && text && isBunFetchSocketError(text)) {
          text = formatBunFetchSocketError(text);
        }

        if (!text || !text.includes("HEARTBEAT_OK")) {
          return [{ ...payload, text }];
        }
        const stripped = stripHeartbeatToken(text, { mode: "message" });
        if (stripped.didStrip && !didLogHeartbeatStrip) {
          didLogHeartbeatStrip = true;
          logVerbose("Stripped stray HEARTBEAT_OK token from reply");
        }
        const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
        if (stripped.shouldSkip && !hasMedia) {
          return [];
        }
        return [{ ...payload, text: stripped.text }];
      });

  const replyTaggedPayloads: ReplyPayload[] = applyReplyThreading({
    payloads: sanitizedPayloads,
    replyToMode: params.replyToMode,
    replyToChannel: params.replyToChannel,
    currentMessageId: params.currentMessageId,
  })
    .map(
      (payload) =>
        normalizeReplyPayloadDirectives({
          payload,
          currentMessageId: params.currentMessageId,
          silentToken: SILENT_REPLY_TOKEN,
          parseMode: "always",
        }).payload,
    )
    .filter(isRenderablePayload);

  // Drop final payloads only when block streaming succeeded end-to-end.
  // If streaming aborted (e.g., timeout), fall back to final payloads.
  const shouldDropFinalPayloads =
    params.blockStreamingEnabled &&
    Boolean(params.blockReplyPipeline?.didStream()) &&
    !params.blockReplyPipeline?.isAborted();
  const messagingToolSentTexts = params.messagingToolSentTexts ?? [];
  const messagingToolSentTargets = params.messagingToolSentTargets ?? [];
  const suppressMessagingToolReplies = shouldSuppressMessagingToolReplies({
    messageProvider: resolveOriginMessageProvider({
      originatingChannel: params.originatingChannel,
      provider: params.messageProvider,
    }),
    messagingToolSentTargets,
    originatingTo: resolveOriginMessageTo({
      originatingTo: params.originatingTo,
    }),
    accountId: resolveOriginAccountId({
      originatingAccountId: params.accountId,
    }),
  });
  // Only dedupe against messaging tool sends for the same origin target.
  // Cross-target sends (for example posting to another channel) must not
  // suppress the current conversation's final reply.
  // If target metadata is unavailable, keep legacy dedupe behavior.
  const dedupeMessagingToolPayloads =
    suppressMessagingToolReplies || messagingToolSentTargets.length === 0;
  const dedupedPayloads = dedupeMessagingToolPayloads
    ? filterMessagingToolDuplicates({
        payloads: replyTaggedPayloads,
        sentTexts: messagingToolSentTexts,
      })
    : replyTaggedPayloads;
  const mediaFilteredPayloads = dedupeMessagingToolPayloads
    ? filterMessagingToolMediaDuplicates({
        payloads: dedupedPayloads,
        sentMediaUrls: params.messagingToolSentMediaUrls ?? [],
      })
    : dedupedPayloads;
  // Filter out payloads already sent via pipeline or directly during tool flush.
  const filteredPayloads = shouldDropFinalPayloads
    ? []
    : params.blockStreamingEnabled
      ? mediaFilteredPayloads.filter(
          (payload) => !params.blockReplyPipeline?.hasSentPayload(payload),
        )
      : params.directlySentBlockKeys?.size
        ? mediaFilteredPayloads.filter(
            (payload) => !params.directlySentBlockKeys!.has(createBlockReplyPayloadKey(payload)),
          )
        : mediaFilteredPayloads;
  const replyPayloads = suppressMessagingToolReplies ? [] : filteredPayloads;

  return {
    replyPayloads,
    didLogHeartbeatStrip,
    errorReactionRequested,
  };
}
