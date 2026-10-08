import { expectDefined } from "@openclaw/normalization-core";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
// Finalizes outbound modifying policy before durable queue custody is created.
import type { ReplyPayload } from "../../auto-reply/types.js";
import { splitMediaFromOutput } from "../../media/parse.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { throwIfAborted } from "./abort.js";
import { createChannelHandler } from "./deliver-channel.js";
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import { applyMessageSendingHook, applyReplyPayloadSendingHook } from "./deliver-hooks.js";
import {
  buildPayloadSummary,
  normalizePayloadsForChannelDelivery,
  normalizeTransformedPayloadForDelivery,
  resolveChannelHandlerParams,
  stripInternalRuntimeScaffoldingFromPayload,
} from "./deliver-payload.js";
import { createOutboundPayloadPlan, createStructuredOutboundPayloadPlan } from "./payloads.js";
import {
  PREPARED_OUTBOUND_BATCH_SCHEMA_VERSION,
  type PreparedOutboundBatch,
  type PreparedOutboundBatchEntry,
} from "./prepared-batch.js";
import type { OutboundPayloadPlan } from "./reply-payload-parts.js";
import { createReplyToDeliveryPolicy, normalizeOutboundReplyFacts } from "./reply-policy.js";

class OutboundPayloadPreparationError extends Error {
  readonly sourceIndex: number;
  readonly payload: ReplyPayload;

  constructor(error: unknown, sourceIndex: number, payload: ReplyPayload) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
    this.name = "OutboundPayloadPreparationError";
    this.sourceIndex = sourceIndex;
    this.payload = payload;
  }
}

function throwIfPreparationAborted(
  signal: AbortSignal | undefined,
  sourceIndex: number,
  payload: ReplyPayload,
): void {
  try {
    throwIfAborted(signal);
  } catch (error) {
    throw new OutboundPayloadPreparationError(error, sourceIndex, payload);
  }
}

function compactPreparedPayload(payload: ReplyPayload): ReplyPayload {
  const summary = buildPayloadSummary(payload);
  const {
    audioAsVoice,
    mediaUrl: _mediaUrl,
    mediaUrls: _mediaUrls,
    replyToCurrent,
    replyToId,
    replyToTag,
    text: _text,
    ...rest
  } = payload;
  return copyReplyPayloadMetadata(
    payload,
    Object.fromEntries(
      Object.entries({
        ...rest,
        text: typeof payload.text === "string" ? summary.text : undefined,
        mediaUrl: summary.mediaUrls.length === 1 ? summary.mediaUrls[0] : undefined,
        mediaUrls: summary.mediaUrls.length > 1 ? summary.mediaUrls : undefined,
        replyToId,
        replyToTag: replyToTag === true ? true : undefined,
        replyToCurrent: replyToCurrent === true ? true : undefined,
        audioAsVoice: audioAsVoice === true ? true : undefined,
      }).filter(([, value]) => value !== undefined),
    ) as ReplyPayload,
  );
}

function preserveTransformedPayloadMetadata(
  source: ReplyPayload,
  payload: ReplyPayload,
): ReplyPayload {
  const transformedMetadata = getReplyPayloadMetadata(payload);
  copyReplyPayloadMetadata(source, payload);
  // The transform may have explicitly updated or cleared an owner-held fact.
  return transformedMetadata ? setReplyPayloadMetadata(payload, transformedMetadata) : payload;
}

function projectMarkdownImages(payload: ReplyPayload): ReplyPayload {
  const images = splitMediaFromOutput(payload.text ?? "", {
    extractMediaDirectives: false,
    extractAudioDirectives: false,
    extractMarkdownImages: true,
    preserveTrailingWhitespace: true,
  });
  if (!images.mediaUrls?.length) {
    return payload;
  }
  // Preserve attachment associations without reapplying reply-lane policy to hook output.
  const [mediaPlan] = createStructuredOutboundPayloadPlan([
    {
      mediaUrl: payload.mediaUrl ?? images.mediaUrls[0],
      mediaUrls: [
        ...(payload.mediaUrls ?? []),
        ...(payload.mediaUrl ? [payload.mediaUrl] : []),
        ...images.mediaUrls,
      ],
      attachments: payload.attachments,
    },
  ]);
  const media = expectDefined(mediaPlan, "Markdown images must produce a media payload").payload;
  return copyReplyPayloadMetadata(payload, {
    ...payload,
    text: images.text,
    mediaUrl: media.mediaUrl,
    mediaUrls: media.mediaUrls,
    ...(payload.attachments ? { attachments: media.attachments } : {}),
  });
}

type OutboundPayloadPreparationOptions = {
  onBeforeFirstModifier?: () => Promise<void>;
  hookRunner?: HookRunner;
};

/**
 * Runs each modifier exactly once and returns the sole payload representation
 * eligible for durable persistence or provider delivery.
 */
export async function prepareOutboundPayloadBatch(
  params: DeliverOutboundPayloadsParams,
  options?: OutboundPayloadPreparationOptions,
): Promise<PreparedOutboundBatch> {
  return await prepareOutboundPlan(params, undefined, options);
}

export async function prepareStructuredOutboundPayloadBatch(
  params: DeliverOutboundPayloadsParams,
  plan: readonly OutboundPayloadPlan[],
  options?: OutboundPayloadPreparationOptions,
): Promise<PreparedOutboundBatch> {
  return await prepareOutboundPlan(params, plan, options);
}

async function prepareOutboundPlan(
  params: DeliverOutboundPayloadsParams,
  structuredPlan: readonly OutboundPayloadPlan[] | undefined,
  options?: OutboundPayloadPreparationOptions,
): Promise<PreparedOutboundBatch> {
  const handler = await createChannelHandler(
    resolveChannelHandlerParams(params, normalizeOutboundReplyFacts(params), []),
  );
  let plan =
    structuredPlan ??
    createOutboundPayloadPlan(params.payloads, {
      cfg: params.cfg,
      sessionKey: params.session?.policyKey ?? params.session?.key,
      surface: params.channel,
      conversationType: params.session?.conversationType,
      extractMarkdownImages: handler.extractMarkdownImages,
    });
  if (structuredPlan && handler.extractMarkdownImages) {
    plan = structuredPlan.flatMap((entry) => {
      const payload = projectMarkdownImages(entry.payload);
      if (payload === entry.payload) {
        return [entry];
      }
      const [projected] = createStructuredOutboundPayloadPlan([payload]);
      return projected ? [{ ...projected, sourceIndex: entry.sourceIndex }] : [];
    });
  }
  const preservePayloadMetadata = structuredPlan ? preserveTransformedPayloadMetadata : undefined;
  const copyMetadata = preservePayloadMetadata ?? ((_source, payload) => payload);
  const normalized = normalizePayloadsForChannelDelivery(plan, handler, preservePayloadMetadata);
  const normalizedIndexes = new Set(normalized.map((entry) => entry.index));
  const entries: PreparedOutboundBatchEntry[] = [];
  for (const [sourceIndex] of params.payloads.entries()) {
    if (!normalizedIndexes.has(sourceIndex)) {
      entries.push({ sourceIndex, status: "suppressed", reason: "no_visible_payload" });
    }
  }

  const hookRunner = options?.hookRunner ?? getGlobalHookRunner();
  const hasReplyPayloadSendingHooks =
    params.replyPayloadSendingHook !== undefined &&
    (hookRunner?.hasHooks("reply_payload_sending") ?? false);
  const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
  const hasModifyingHooks = hasReplyPayloadSendingHooks || hasMessageSendingHooks;
  const { resolveCurrentReplyTo } = createReplyToDeliveryPolicy(params);
  const sessionKeyForHooks = params.mirror?.sessionKey ?? params.session?.key;
  const modifiers = [
    {
      changedKey: "replyHookChanged",
      cancellationReason: "cancelled_by_reply_payload_sending_hook",
      apply: (payload: ReplyPayload) =>
        applyReplyPayloadSendingHook({ hook: params.replyPayloadSendingHook, payload }, hookRunner),
    },
    {
      changedKey: "messageHookChanged",
      cancellationReason: "cancelled_by_message_sending_hook",
      apply: (payload: ReplyPayload) =>
        applyMessageSendingHook({
          hookRunner,
          enabled: hasMessageSendingHooks,
          payload,
          payloadSummary: buildPayloadSummary(payload),
          to: params.to,
          channel: params.channel,
          accountId: params.accountId,
          replyToId: resolveCurrentReplyTo(payload).replyToId,
          threadId: params.threadId,
          sessionKey: sessionKeyForHooks,
        }),
    },
  ] as const;
  let modifierBoundaryEntered = false;

  payloads: for (const { index: sourceIndex, payload } of normalized) {
    throwIfPreparationAborted(params.abortSignal, sourceIndex, payload);
    if (hasModifyingHooks && !modifierBoundaryEntered) {
      await options?.onBeforeFirstModifier?.();
      throwIfPreparationAborted(params.abortSignal, sourceIndex, payload);
      modifierBoundaryEntered = true;
    }
    const changes = { replyHookChanged: false, messageHookChanged: false };
    let postHookPayload = payload;
    for (const modifier of modifiers) {
      let result: Awaited<ReturnType<typeof applyMessageSendingHook>>;
      try {
        result = await modifier.apply(postHookPayload);
      } catch (error) {
        // Modifier handlers are fail-open. Only a host invariant failure can
        // escape here, and atomic preparation must attribute it before aborting.
        throw new OutboundPayloadPreparationError(error, sourceIndex, postHookPayload);
      }
      postHookPayload = copyMetadata(postHookPayload, result.payload);
      throwIfPreparationAborted(params.abortSignal, sourceIndex, postHookPayload);
      if (result.cancelled) {
        entries.push({
          sourceIndex,
          status: "suppressed",
          reason: modifier.cancellationReason,
          ...(result.hookEffect ? { hookEffect: result.hookEffect } : {}),
        });
        continue payloads;
      }
      changes[modifier.changedKey] = result.changed;
      postHookPayload = stripInternalRuntimeScaffoldingFromPayload(postHookPayload);
      if (handler.extractMarkdownImages && result.changed) {
        postHookPayload = projectMarkdownImages(postHookPayload);
      }
    }
    // Adapter normalization may project visible text into transport fields. Re-run it
    // after policy so durable custody cannot retain a stale pre-rewrite projection.
    const preparedPayload = normalizeTransformedPayloadForDelivery(
      postHookPayload,
      handler,
      copyMetadata,
    );
    if (!preparedPayload) {
      entries.push({
        sourceIndex,
        status: "suppressed",
        reason: changes.messageHookChanged
          ? "empty_after_message_sending_hook"
          : changes.replyHookChanged
            ? "empty_after_reply_payload_sending_hook"
            : "no_visible_payload",
      });
      continue;
    }
    const compactPayload = compactPreparedPayload(preparedPayload);
    entries.push({
      sourceIndex,
      status: "accepted",
      payload: compactPayload,
      ...changes,
      preparedMediaCount: buildPayloadSummary(compactPayload).mediaUrls.length,
    });
  }

  const runId = params.runId ?? params.replyPayloadSendingHook?.runId;
  return {
    schemaVersion: PREPARED_OUTBOUND_BATCH_SCHEMA_VERSION,
    sourcePayloadCount: params.payloads.length,
    channelNormalized: true,
    ...(runId ? { runId } : {}),
    ...(params.executionIdentityToken
      ? { executionIdentityToken: params.executionIdentityToken }
      : {}),
    entries,
  };
}
