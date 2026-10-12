// Executes normalized outbound payloads against the selected channel transport.
import { randomUUID } from "node:crypto";
import { resolveChunkMode, resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { payloadRequiresDurablePayloadTransport } from "../../channels/message/capabilities.js";
import { renderPresentationForDelivery } from "../../channels/plugins/outbound/presentation-delivery.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { commitConfirmedVisibleMessage } from "../../sessions/background-session-result.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import { diagnosticErrorCategory } from "../diagnostic-error-metadata.js";
import {
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
  type DiagnosticMessageDeliveryKind,
} from "../diagnostic-events.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import { createChannelHandler } from "./deliver-channel.js";
import type { ChannelHandler, DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import { assertOutboundHandoffCurrent } from "./deliver-handoff.js";
import {
  buildPayloadSummary,
  deliveryKindForPayload,
  maybeNotifyAfterDeliveredPayload,
  maybePinDeliveredMessage,
  normalizeEmptyPayloadForDelivery,
  resolveChannelHandlerParams,
  stripInternalRuntimeScaffoldingFromPayload,
} from "./deliver-payload.js";
import { createDeliveryResultRecorder } from "./deliver-results.js";
import {
  OutboundDeliveryError,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryKind,
  type OutboundPayloadDeliveryOutcome,
  type OutboundPayloadDeliverySuppressionReason,
} from "./deliver-types.js";
import {
  assertStableMediaFanout,
  planOutboundMediaMessageUnits,
  planOutboundTextMessageUnits,
  type OutboundMessageSendOverrides,
} from "./message-plan.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import {
  acceptedPreparedOutboundEntries,
  preparedOutboundSuppressionOutcomes,
} from "./prepared-batch.js";
import { createReplyToDeliveryPolicy } from "./reply-policy.js";

const log = createSubsystemLogger("outbound/deliver");

export async function deliverOutboundPayloadsCore(
  params: DeliverOutboundPayloadsCoreParams,
): Promise<OutboundDeliveryResult[]> {
  const { cfg, channel, to } = params;
  const preparedBatch = params.preparedBatch;
  if (!preparedBatch) {
    throw new Error("Outbound delivery requires a prepared payload batch");
  }
  const accountId = params.accountId;
  const reply = params.reply;
  const deps = params.deps;
  const abortSignal = params.abortSignal;
  const results: OutboundDeliveryResult[] = [];
  const {
    recordIdentifiedDeliveryResult,
    recordIdentifiedDeliveryResults,
    reportIdentifiedDeliveryResult,
    getSuppressionReason,
    resetPayloadResults,
  } = createDeliveryResultRecorder({
    results,
    onDeliveryResult: params.onDeliveryResult,
  });
  let activeSourceIndex: number | undefined;
  let payloadSendStarted: boolean;
  const createHandler = (mediaSources: readonly string[]) =>
    createChannelHandler({
      ...resolveChannelHandlerParams(params, reply, mediaSources),
      cfg,
      channel,
      to,
      deps,
      accountId,
      abortSignal,
      deliveryQueueId: params.deliveryQueueId,
      onPlatformSendStart: async (route) => {
        // Channel handlers can fan one logical payload into multiple sends.
        // Carry its source index without polluting the persisted platform route.
        payloadSendStarted = true;
        await params.onPlatformSendStart?.(route, activeSourceIndex);
      },
      onDirectAdapterHandoff: params.onDirectAdapterHandoff,
      withDirectAdapterHandoff: params.withDirectAdapterHandoff,
      assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
      onPlatformSendDispatch: params.onPlatformSendDispatch,
      onDeliveryResult: reportIdentifiedDeliveryResult,
    });
  const baseHandler = await createHandler([]);
  let preparedTarget = baseHandler.buildTargetRef({ threadId: params.threadId });
  const maybeAdoptTargetFromDelivery = (result: OutboundDeliveryResult): void => {
    if (params.threadId != null || preparedTarget.threadId != null) {
      return;
    }
    const adoptedTarget = baseHandler.adoptTargetFromDelivery?.({ target: preparedTarget, result });
    if (adoptedTarget?.threadId != null) {
      // The adapter owns receipt semantics; core only carries its typed target forward.
      preparedTarget = { ...preparedTarget, threadId: adoptedTarget.threadId };
    }
  };
  const withPreparedTarget = <T extends OutboundMessageSendOverrides>(overrides: T): T =>
    preparedTarget.threadId == null
      ? overrides
      : { ...overrides, threadId: preparedTarget.threadId };
  const adoptSuccessfulResultsSince = (resultIndex: number): void => {
    for (const result of results.slice(resultIndex)) {
      maybeAdoptTargetFromDelivery(result);
    }
  };
  const handlerByMediaSources = new Map<string, Promise<ChannelHandler>>();
  const getDeliveryHandler = (mediaSources: readonly string[]): Promise<ChannelHandler> => {
    if (mediaSources.length === 0) {
      return Promise.resolve(baseHandler);
    }
    const key = JSON.stringify(mediaSources);
    return getOrCreatePromise(handlerByMediaSources, key, () => createHandler(mediaSources));
  };
  const configuredTextLimit = baseHandler.chunker
    ? resolveTextChunkLimit(cfg, channel, accountId, {
        fallbackLimit: baseHandler.textChunkLimit,
      })
    : undefined;
  const textLimit =
    params.formatting?.textLimit ??
    (baseHandler.resolveEffectiveTextChunkLimit
      ? baseHandler.resolveEffectiveTextChunkLimit({
          fallbackLimit: configuredTextLimit,
          formatting: params.formatting,
        })
      : configuredTextLimit);
  const chunkMode = baseHandler.chunker
    ? (params.formatting?.chunkMode ?? resolveChunkMode(cfg, channel, accountId))
    : "length";
  const { resolveCurrentReplyTo, applyReplyToConsumption } = createReplyToDeliveryPolicy({
    reply,
  });

  const sendTextChunks = async (
    sendHandler: ChannelHandler,
    text: string,
    overrides: OutboundMessageSendOverrides,
  ) => {
    const units = planOutboundTextMessageUnits({
      text,
      overrides,
      chunker: sendHandler.chunker,
      chunkerMode: sendHandler.chunkerMode,
      chunkedTextFormatting: sendHandler.chunkedTextFormatting,
      textLimit,
      chunkMode,
      formatting: params.formatting,
      consumeReplyTo: applyReplyToConsumption,
    });
    for (const unit of units) {
      throwIfAborted(abortSignal);
      const resultIndex = results.length;
      await recordIdentifiedDeliveryResult(
        await sendHandler.sendText(unit.text, withPreparedTarget(unit.overrides)),
      );
      adoptSuccessfulResultsSince(resultIndex);
    }
  };
  const acceptedEntries = acceptedPreparedOutboundEntries(preparedBatch);
  const payloadOutcomes: OutboundPayloadDeliveryOutcome[] = [
    ...preparedOutboundSuppressionOutcomes(preparedBatch),
  ];
  for (const outcome of payloadOutcomes) {
    params.onPayloadDeliveryOutcome?.(outcome);
  }
  const transcriptDeliveryId =
    params.transcriptDeliveryId ??
    params.deliveryQueueId ??
    params.deliveryIntentId ??
    randomUUID();
  const recordDeliveredPayload = async (
    payloadSummary: NormalizedOutboundPayload,
    payload: ReplyPayload,
    payloadIndex: number,
  ): Promise<void> => {
    // Post-send observers are bookkeeping only. Never turn an identified
    // platform delivery into a retryable failure if an observer misbehaves.
    try {
      params.onDeliveredPayload?.(payloadSummary);
    } catch (error) {
      log.warn("Outbound delivered-payload observer failed after platform send.", {
        channel,
        to,
        error: formatErrorMessage(error),
      });
    }
    let diagnostic: string | undefined;
    try {
      const threadChanged =
        preparedTarget.threadId != null &&
        String(preparedTarget.threadId) !==
          String(params.transcriptRoute?.threadId ?? params.threadId);
      const result = await commitConfirmedVisibleMessage({
        config: cfg,
        channel,
        to,
        accountId,
        threadId: preparedTarget.threadId ?? undefined,
        route: threadChanged ? undefined : params.transcriptRoute,
        producer: params.session,
        payload,
        deliveryId: transcriptDeliveryId,
        payloadIndex,
        signal: abortSignal,
        expectedGeneration: threadChanged ? undefined : params.transcriptExpectedGeneration,
        assertCurrent: params.assertTranscriptCurrent,
        assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
      });
      diagnostic = result.ok
        ? result.diagnostics
        : `result was delivered but was not added to the conversation: ${result.reason}`;
    } catch (error) {
      diagnostic = `result was delivered but was not added to the conversation: ${formatErrorMessage(error)}`;
    }
    if (diagnostic) {
      log.warn(`Confirmed outbound transcript: ${diagnostic}`, { channel, to });
      try {
        params.onTranscriptDiagnostic?.(diagnostic);
      } catch {
        // Diagnostics cannot make a confirmed send retryable.
      }
    }
  };
  // `policyKey` is a diagnostics-only fallback; never use it for hook correlation.
  const diagnosticSessionKey = params.session?.key ?? params.session?.policyKey;
  for (const [deliveryPayloadIndex, preparedEntry] of acceptedEntries.entries()) {
    // A rejected adapter has no final return; never match its progress or
    // suppression disposition to a later logical payload.
    resetPayloadResults();
    const payloadIndex = preparedEntry.sourceIndex;
    activeSourceIndex = payloadIndex;
    payloadSendStarted = false;
    const payload = preparedEntry.payload;
    const payloadResultStartIndex = results.length;
    let effectivePayload: typeof payload | null | undefined;
    let payloadSummary = buildPayloadSummary(payload);
    const originalMediaCount = preparedEntry.preparedMediaCount;
    let effectiveDeliveryKind: OutboundPayloadDeliveryKind | undefined;
    const recordPayloadOutcome = (outcome: OutboundPayloadDeliveryOutcome): void => {
      const recordedOutcome =
        effectiveDeliveryKind && outcome.status !== "suppressed"
          ? { ...outcome, deliveryKind: effectiveDeliveryKind }
          : outcome;
      payloadOutcomes.push(recordedOutcome);
      params.onPayloadDeliveryOutcome?.(recordedOutcome);
    };
    const recordSuppressedPayload = (reason: OutboundPayloadDeliverySuppressionReason): void =>
      recordPayloadOutcome({ index: payloadIndex, status: "suppressed", reason });
    let deliveryKind: DiagnosticMessageDeliveryKind = "other";
    let deliveryStartedAt = 0;
    let deliveryPending = false;
    let messageSentEventRecorded = false;
    const recordMessageSentEvent = (
      event: Parameters<NonNullable<typeof params.onMessageSentEvent>>[0],
    ): void => {
      if (messageSentEventRecorded) {
        return;
      }
      messageSentEventRecorded = true;
      params.onMessageSentEvent?.(event, payloadIndex);
    };
    const startDeliveryDiagnostics = (kind: DiagnosticMessageDeliveryKind) => {
      deliveryKind = kind;
      deliveryStartedAt = Date.now();
      deliveryPending = true;
      emitDiagnosticEvent({
        type: "message.delivery.started",
        channel,
        deliveryKind,
        ...(diagnosticSessionKey ? { sessionKey: diagnosticSessionKey } : {}),
      });
    };
    const finishDeliveryDiagnostics = (result: number | { error: unknown }) => {
      if (!deliveryPending) {
        return;
      }
      deliveryPending = false;
      const delivery = {
        channel,
        deliveryKind,
        durationMs: Date.now() - deliveryStartedAt,
        ...(diagnosticSessionKey ? { sessionKey: diagnosticSessionKey } : {}),
      };
      emitDiagnosticEvent(
        typeof result === "number"
          ? { type: "message.delivery.completed", ...delivery, resultCount: result }
          : {
              type: "message.delivery.error",
              ...delivery,
              errorCategory: diagnosticErrorCategory(result.error),
            },
      );
    };
    try {
      throwIfAborted(abortSignal);

      const presentationHandler = await getDeliveryHandler(payloadSummary.mediaUrls);
      const renderedPayload = stripInternalRuntimeScaffoldingFromPayload(
        await renderPresentationForDelivery(presentationHandler, payload),
      );
      const renderedHandler = await getDeliveryHandler(
        buildPayloadSummary(renderedPayload).mediaUrls,
      );
      // Preparation already normalized the post-policy payload. Normalize again
      // only when presentation rendering creates a new transport representation.
      const normalizedEffectivePayload =
        (preparedBatch.channelNormalized !== true || renderedPayload !== payload) &&
        renderedHandler.normalizePayload
          ? renderedHandler.normalizePayload(renderedPayload)
          : renderedPayload;
      effectivePayload = normalizedEffectivePayload
        ? normalizeEmptyPayloadForDelivery(
            stripInternalRuntimeScaffoldingFromPayload(normalizedEffectivePayload),
          )
        : null;
      if (!effectivePayload) {
        recordSuppressedPayload(
          preparedEntry.messageHookChanged
            ? "empty_after_message_sending_hook"
            : preparedEntry.replyHookChanged
              ? "empty_after_reply_payload_sending_hook"
              : "no_visible_payload",
        );
        continue;
      }
      const effectivePayloadSummary = buildPayloadSummary(effectivePayload);
      assertStableMediaFanout(
        params,
        deliveryPayloadIndex,
        originalMediaCount,
        effectivePayloadSummary,
      );
      payloadSummary = effectivePayloadSummary;
      const deliveryHandler = await getDeliveryHandler(payloadSummary.mediaUrls);
      effectiveDeliveryKind = deliveryKindForPayload(effectivePayload, payloadSummary);
      startDeliveryDiagnostics(effectiveDeliveryKind);

      params.onPayload?.(payloadSummary);
      const replyToResolution = resolveCurrentReplyTo(effectivePayload);
      const sendOverrides: OutboundMessageSendOverrides = {
        replyToId: replyToResolution.replyToId,
        replyToIdSource: replyToResolution.source,
        ...(preparedTarget.threadId != null ? { threadId: preparedTarget.threadId } : {}),
        ...(effectivePayload.audioAsVoice === true ? { audioAsVoice: true } : {}),
      };
      const deliveryTarget = () =>
        deliveryHandler.buildTargetRef({ threadId: preparedTarget.threadId });
      const beforeCount = results.length;
      let deliveredPayload = effectivePayload;
      let mediaMessageIds: { first?: string; last?: string } | undefined;
      if (
        deliveryHandler.sendPayload &&
        ((deliveryHandler.supportsMediaPayload && payloadSummary.mediaUrls.length > 1) ||
          payloadRequiresDurablePayloadTransport(effectivePayload, {
            sendTextOnlyErrorPayloads: deliveryHandler.sendTextOnlyErrorPayloads,
          }))
      ) {
        const delivery = await deliveryHandler.sendPayload(
          effectivePayload,
          withPreparedTarget(applyReplyToConsumption(sendOverrides)),
        );
        await recordIdentifiedDeliveryResult(delivery);
        adoptSuccessfulResultsSince(beforeCount);
        if (results.length <= beforeCount) {
          finishDeliveryDiagnostics(0);
          recordSuppressedPayload(getSuppressionReason() ?? "adapter_returned_no_identity");
          continue;
        }
      } else if (payloadSummary.mediaUrls.length === 0) {
        if (deliveryHandler.sendFormattedText) {
          await recordIdentifiedDeliveryResults(
            await deliveryHandler.sendFormattedText(
              payloadSummary.text,
              withPreparedTarget(applyReplyToConsumption(sendOverrides)),
            ),
          );
          adoptSuccessfulResultsSince(beforeCount);
        } else {
          await sendTextChunks(deliveryHandler, payloadSummary.text, sendOverrides);
        }
      } else if (!deliveryHandler.supportsMedia) {
        log.warn(
          "Plugin outbound adapter does not implement sendMedia or sendFormattedMedia; media URLs will be dropped and text fallback will be used",
          {
            channel,
            to,
            mediaCount: payloadSummary.mediaUrls.length,
          },
        );
        const fallbackText = payloadSummary.text.trim();
        if (!fallbackText) {
          throw new Error(
            "Plugin outbound adapter does not implement sendMedia or sendFormattedMedia and no text fallback is available for media payload",
          );
        }
        await sendTextChunks(deliveryHandler, fallbackText, sendOverrides);
        deliveredPayload = { text: fallbackText };
      } else {
        // Media observers use final adapter identities, not intermediate progress
        // results that may also remain in the reconciled delivery list.
        mediaMessageIds = {};
        const mediaUnits = planOutboundMediaMessageUnits({
          mediaUrls: payloadSummary.mediaUrls,
          caption: payloadSummary.text,
          overrides: sendOverrides,
          consumeReplyTo: applyReplyToConsumption,
        });
        const sendMedia = deliveryHandler.sendFormattedMedia ?? deliveryHandler.sendMedia;
        for (const unit of mediaUnits) {
          throwIfAborted(abortSignal);
          const resultIndex = results.length;
          const delivery = await sendMedia(
            unit.caption ?? "",
            unit.mediaUrl,
            withPreparedTarget(unit.overrides),
          );
          const recorded = await recordIdentifiedDeliveryResult(delivery);
          adoptSuccessfulResultsSince(resultIndex);
          if (recorded) {
            mediaMessageIds.first ??= delivery.messageId;
            mediaMessageIds.last = delivery.messageId;
          }
        }
      }

      const deliveredResults = results.slice(beforeCount);
      if (deliveredResults.length > 0) {
        recordPayloadOutcome({
          index: payloadIndex,
          status: "sent",
          results: deliveredResults,
        });
        if (!getSuppressionReason()) {
          await recordDeliveredPayload(
            buildPayloadSummary(deliveredPayload),
            deliveredPayload,
            payloadIndex,
          );
        }
      } else {
        recordSuppressedPayload(getSuppressionReason() ?? "adapter_returned_no_identity");
        if (getSuppressionReason() === "adapter_returned_no_send") {
          finishDeliveryDiagnostics(0);
          continue;
        }
      }
      const firstMessageId = mediaMessageIds
        ? mediaMessageIds.first
        : deliveredResults.find((entry) => entry.messageId)?.messageId;
      const lastMessageId = mediaMessageIds
        ? mediaMessageIds.last
        : deliveredResults.at(-1)?.messageId;
      recordMessageSentEvent({
        success: deliveredResults.length > 0,
        content: payloadSummary.hookContent ?? payloadSummary.text,
        messageId: lastMessageId,
      });
      await maybePinDeliveredMessage({
        handler: deliveryHandler,
        payload: effectivePayload,
        target: deliveryTarget(),
        messageId: firstMessageId,
        gatewayClientScopes: params.gatewayClientScopes,
        assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
      });
      await maybeNotifyAfterDeliveredPayload({
        handler: deliveryHandler,
        payload: effectivePayload,
        target: deliveryTarget(),
        results: deliveredResults,
      });
      finishDeliveryDiagnostics(deliveredResults.length);
    } catch (caughtError) {
      let err = caughtError;
      if (!payloadSendStarted) {
        // Rendering and handler preparation cannot have dispatched this payload.
        // Preserve earlier payload evidence when reporting its rejected handoff.
        try {
          assertOutboundHandoffCurrent(params.assertDirectAdapterHandoff);
        } catch (rejection) {
          err = rejection;
        }
      }
      const failedPayloadResults = results.slice(payloadResultStartIndex);
      adoptSuccessfulResultsSince(payloadResultStartIndex);
      if (effectivePayload && failedPayloadResults.length > 0) {
        await maybeNotifyAfterDeliveredPayload({
          handler: await getDeliveryHandler(buildPayloadSummary(effectivePayload).mediaUrls),
          payload: effectivePayload,
          target: baseHandler.buildTargetRef({ threadId: preparedTarget.threadId }),
          results: failedPayloadResults,
        });
      }
      recordPayloadOutcome({
        index: payloadIndex,
        status: "failed",
        error: err,
        // A later pre-send failure cannot erase an earlier chunk's unknown result.
        sentBeforeError:
          failedPayloadResults.length > 0 ||
          getSuppressionReason() === "adapter_returned_no_identity",
        stage: "platform_send",
        results: failedPayloadResults,
      });
      finishDeliveryDiagnostics({ error: err });
      // A completed provider send records success before optional pin/notify
      // bookkeeping. Reaching this fallback first means the logical payload's
      // provider fan-out itself was incomplete, even if an earlier part sent.
      recordMessageSentEvent({
        success: false,
        content: payloadSummary.hookContent ?? payloadSummary.text,
        error: formatErrorMessage(err),
        ...(failedPayloadResults.at(-1)?.messageId
          ? { messageId: failedPayloadResults.at(-1)!.messageId }
          : {}),
      });
      if (!params.bestEffort) {
        throw err instanceof OutboundDeliveryError
          ? err
          : new OutboundDeliveryError(formatErrorMessage(err), {
              cause: err,
              results,
              payloadOutcomes,
              stage: "platform_send",
            });
      }
      params.onError?.(err, payloadSummary);
    }
  }

  return results;
}
