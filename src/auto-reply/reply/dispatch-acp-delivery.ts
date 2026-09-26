// Delivers ACP turn results through reply payload routing.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import {
  buildCaptionedFinalTextFallback,
  cleanDeferredFinalText,
  isCaptionedFinalTextPayload,
  mergeDeferredFinalText,
} from "../../tts/captioned-final.js";
import { createTtsDirectiveTextStreamCleaner } from "../../tts/directives.js";
import { shouldCleanTtsDirectiveText } from "../../tts/tts-config.js";
import {
  copyReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  isReplyPayloadTtsSupplement,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { createBlockReplySource, setBlockReplyDelivery } from "./block-reply-delivery.js";
import type { BlockReplySource } from "./block-reply-source.types.js";
import type {
  AcpBlockText,
  AcpDispatchDeliveryMeta,
  AcpDispatchDeliveryParams,
  AcpDispatchDeliveryState,
} from "./dispatch-acp-delivery.types.js";
import {
  buildAcpTextContinuation,
  getAcpBlockTranscriptText,
  joinAcpBlockText,
  maybeApplyAcpTts,
  prepareAcpDeliveryPayload,
  recoverAcpBlockText,
  shouldTreatDeliveredTextAsVisible,
} from "./dispatch-acp-payload.js";
import {
  resolveRoutedReplyDeliveryOutcome,
  shouldRetryReplyDispatch,
} from "./reply-dispatch-outcome.js";
import {
  attachReplyDispatchUndeliveredFallback,
  captureReplyDispatchDeliveryOutcome,
  waitForReplyDispatcherIdle,
} from "./reply-dispatcher.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";
import {
  createReplyDeliveryContext,
  resolveReplyDeliveryAccountId,
  resolveReplyToMode,
} from "./reply-threading.js";
import { resolveRoutedDeliveryThreadId } from "./routed-delivery-thread.js";

const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));
const channelPluginRuntimeLoader = createLazyImportLoader(
  () => import("../../channels/plugins/index.js"),
);
const messageActionRuntimeLoader = createLazyImportLoader(
  () => import("../../infra/outbound/message-action-runner.js"),
);

export type AcpDispatchDeliveryCoordinator = ReturnType<
  typeof createAcpDispatchDeliveryCoordinator
>;

export function createAcpDispatchDeliveryCoordinator(params: AcpDispatchDeliveryParams) {
  const directChannel = normalizeOptionalLowercaseString(params.ctx.Provider ?? params.ctx.Surface);
  const routedChannel = normalizeOptionalLowercaseString(params.originatingChannel);
  const deliverySessionKey = normalizeOptionalString(params.sessionKey) ?? params.ctx.SessionKey;
  const explicitAccountId =
    normalizeOptionalString(params.originatingAccountId) ??
    normalizeOptionalString(params.ctx.AccountId);
  const resolvedAccountId = resolveReplyDeliveryAccountId(
    params.cfg,
    routedChannel ?? directChannel,
    explicitAccountId,
  );
  const routedReplyDelivery = params.originatingChannel
    ? createReplyDeliveryContext(
        resolveReplyToMode(
          params.cfg,
          params.originatingChannel,
          resolvedAccountId,
          params.originatingChatType ?? params.ctx.ChatType,
        ),
        params.originatingChatType ?? params.ctx.ChatType,
      )
    : undefined;
  const state: AcpDispatchDeliveryState = {
    startedReplyLifecycle: false,
    blockTexts: [],
    accumulatedBlockTtsText: "",
    accumulatedFinalText: "",
    accumulatedDeliveredFinalText: "",
    pendingTranscriptOutcomes: [],
    cleanBlockTtsDirectiveText: shouldCleanTtsDirectiveText({
      cfg: params.cfg,
      ttsAuto: params.sessionTtsAuto,
      agentId: params.agentId,
      channelId: params.ttsChannel,
      accountId: resolvedAccountId,
    })
      ? createTtsDirectiveTextStreamCleaner()
      : undefined,
    deliveredFinalReply: false,
    pendingAnswerDelivery: false,
    pendingFinalTtsMedia: false,
    deliveredAnswerFinalToUser: false,
    deliveredFinalTtsMedia: false,
    deliveredVisibleText: false,
    failedVisibleTextDelivery: false,
    queuedUntrackedVisibleTextDeliveries: 0,
    settledUntrackedVisibleText: false,
    routedCounts: {
      tool: 0,
      block: 0,
      final: 0,
    },
    suppressionReason: undefined,
    toolMessageByCallId: new Map(),
  };
  let hasPendingDirectBlockReplyDelivery = false;
  let pendingBlockSource: BlockReplySource | undefined;
  let drainBlockText: ((text: string) => Promise<boolean>) | undefined;

  const settleDirectVisibleText = async () => {
    // Exact payload settlements own custody and coverage before final fallback reads them.
    await waitForReplyDispatcherIdle(
      {
        waitForIdle: async () => {
          await Promise.all(state.pendingTranscriptOutcomes);
        },
      },
      params.abortSignal,
    );
    if (params.abortSignal?.aborted) {
      return;
    }
    hasPendingDirectBlockReplyDelivery = false;
    if (state.settledUntrackedVisibleText || state.queuedUntrackedVisibleTextDeliveries === 0) {
      return;
    }
    state.settledUntrackedVisibleText = true;
    const receipt = await waitForReplyDispatcherIdle(params.dispatcher, params.abortSignal);
    if (!receipt) {
      return;
    }
    const visibleCounts = [receipt.counts.block, receipt.counts.final];
    state.failedVisibleTextDelivery ||= visibleCounts.some(
      (counts) => counts.failedBeforeSend + counts.failedAfterSend > 0,
    );
    state.deliveredVisibleText ||= visibleCounts.some(
      (counts) => counts.delivered + counts.failedAfterSend > 0,
    );
  };

  const startReplyLifecycleOnce = async () => {
    if (state.startedReplyLifecycle) {
      return;
    }
    state.startedReplyLifecycle = true;
    // Delivery and lifecycle suppression are separate: message-tool-only turns
    // suppress automatic user delivery but still need typing/lifecycle signals.
    if (params.suppressReplyLifecycle) {
      return;
    }
    void Promise.resolve(params.onReplyStart?.()).catch((error: unknown) => {
      logVerbose(`dispatch-acp: reply lifecycle start failed: ${formatErrorMessage(error)}`);
    });
  };

  const tryEditToolMessage = async (
    payload: ReplyPayload,
    toolCallId: string,
  ): Promise<boolean> => {
    const handle = state.toolMessageByCallId.get(toolCallId);
    if (!handle?.messageId) {
      return false;
    }
    const message = normalizeOptionalString(payload.text);
    if (!message) {
      return false;
    }

    try {
      const { runMessageAction } = await messageActionRuntimeLoader.load();
      await runMessageAction({
        cfg: params.cfg,
        action: "edit",
        params: {
          channel: handle.channel,
          to: handle.to,
          threadId: handle.threadId,
          messageId: handle.messageId,
          message,
        },
        defaultAccountId: handle.accountId,
        sessionKey: params.ctx.SessionKey,
        requesterAccountId: params.ctx.AccountId,
      });
      state.routedCounts.tool += 1;
      return true;
    } catch (error) {
      logVerbose(
        `dispatch-acp: tool message edit failed for ${toolCallId}: ${formatErrorMessage(error)}`,
      );
      return false;
    }
  };

  const deliver = async (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    meta?: AcpDispatchDeliveryMeta,
  ): Promise<boolean> => {
    if (kind === "block") {
      setBlockReplyDelivery(Promise.resolve({ outcome: "cancelled" }));
    }
    const transcriptSource = meta?.transcriptSource;
    // Snapshot coverage before preparation/TTS can yield to another payload.
    const coveredBlocks =
      kind === "final"
        ? state.blockTexts.filter(
            (block) => transcriptSource?.kind === "blocks" || block.needsFinalDelivery,
          )
        : [];
    const coverFinalBlockText = (source: ReplyPayload, blocks = coveredBlocks) => {
      if (
        !source.text?.trim() ||
        source.isCommentary ||
        source.isReasoning ||
        isReplyPayloadStatusNotice(source)
      ) {
        return;
      }
      for (const block of blocks) {
        block.needsFinalDelivery = false;
      }
    };
    let visiblePayload = payload;
    if (!params.suppressUserDelivery) {
      const routed = params.shouldRouteToOriginating && routedChannel !== undefined;
      const messaging = routed
        ? (await channelPluginRuntimeLoader.load()).getChannelPlugin(routedChannel)?.messaging
        : undefined;
      const prepared = prepareAcpDeliveryPayload({
        cfg: params.cfg,
        dispatcher: params.dispatcher,
        kind,
        payload,
        routed,
        ...(messaging ? { messaging } : {}),
        accountId: resolvedAccountId,
      });
      if (prepared.kind === "suppress") {
        if (prepared.reason === "channel_transform") {
          state.suppressionReason = prepared.reason;
          coverFinalBlockText(payload);
          if (kind === "block" && payload.text?.trim()) {
            setBlockReplyDelivery(Promise.resolve({ outcome: "channel-transform" }), payload);
          }
        }
        return false;
      }
      visiblePayload = prepared.payload;
    }
    const isStatusNotice = isReplyPayloadStatusNotice(visiblePayload);
    const rawBlockPayloadText =
      kind === "block" ? normalizeOptionalString(visiblePayload.text) : undefined;
    const rawBlockText = isStatusNotice ? undefined : rawBlockPayloadText;
    let blockSource: BlockReplySource | undefined;
    if (rawBlockPayloadText) {
      const joinsBufferedTtsDirective =
        state.cleanBlockTtsDirectiveText?.hasBufferedDirectiveText() === true;
      if (rawBlockText) {
        if (state.accumulatedBlockTtsText.length > 0 && !joinsBufferedTtsDirective) {
          state.accumulatedBlockTtsText += "\n";
        }
        state.accumulatedBlockTtsText += rawBlockText;
      }

      if (state.cleanBlockTtsDirectiveText && rawBlockText) {
        if (!visiblePayload.isCommentary && !visiblePayload.isReasoning) {
          blockSource = pendingBlockSource ?? createBlockReplySource();
        }
        const text = state.cleanBlockTtsDirectiveText.push(rawBlockPayloadText);
        if (blockSource) {
          const hasPendingText = state.cleanBlockTtsDirectiveText.hasBufferedDirectiveText();
          blockSource.setComplete(!hasPendingText);
          pendingBlockSource = hasPendingText ? blockSource : undefined;
        }
        visiblePayload = copyReplyPayloadMetadata(visiblePayload, {
          ...visiblePayload,
          text: text.trim() ? text : undefined,
        });
      }
    }
    const rawFinalText =
      kind === "final" && !isStatusNotice
        ? normalizeOptionalString(visiblePayload.text)
        : undefined;
    if (rawFinalText && !transcriptSource) {
      if (state.accumulatedFinalText.length > 0) {
        state.accumulatedFinalText += "\n";
      }
      state.accumulatedFinalText += rawFinalText;
    }
    const transcriptFinalText = !transcriptSource
      ? rawFinalText
      : transcriptSource.kind === "final"
        ? transcriptSource.text
        : undefined;

    const sendPrepared = async (
      preparedPayload: ReplyPayload,
      deliveredBlock: AcpBlockText | undefined,
      skipTts = meta?.skipTts,
      sendKind = kind,
    ): Promise<boolean> => {
      const recoveringBlock = sendKind === "final" && kind === "block";
      const finalBlocks = recoveringBlock && deliveredBlock ? [deliveredBlock] : coveredBlocks;
      let outgoingPayload = recoveringBlock
        ? deliveredBlock?.delivered || params.suppressBlockUserDelivery
          ? buildAcpTextContinuation(preparedPayload, preparedPayload.text)
          : copyReplyPayloadMetadata(preparedPayload, { ...preparedPayload })
        : preparedPayload;
      if (!hasOutboundReplyContent(outgoingPayload, { trimText: true })) {
        return false;
      }
      await startReplyLifecycleOnce();

      if (params.suppressUserDelivery) {
        return false;
      }
      if (
        sendKind === "block" &&
        params.suppressBlockUserDelivery &&
        !isStatusNotice &&
        !outgoingPayload.isReasoning &&
        !outgoingPayload.isCommentary
      ) {
        const hasNonTextContent = Boolean(
          outgoingPayload.mediaUrl ||
          outgoingPayload.mediaUrls?.length ||
          outgoingPayload.presentation ||
          outgoingPayload.interactive ||
          outgoingPayload.channelData,
        );
        if (!hasNonTextContent) {
          return false;
        }
        outgoingPayload = copyReplyPayloadMetadata(outgoingPayload, {
          ...outgoingPayload,
          text: undefined,
        });
      }

      const appliedTtsPayload = await maybeApplyAcpTts({
        payload: outgoingPayload,
        cfg: params.cfg,
        agentId: params.agentId,
        channel: params.ttsChannel,
        accountId: resolvedAccountId,
        kind: sendKind,
        inboundAudio: params.inboundAudio,
        ttsAuto: params.sessionTtsAuto,
        skipTts,
      });
      const finalVisibleTextSource =
        sendKind === "final" && params.suppressBlockUserDelivery && state.cleanBlockTtsDirectiveText
          ? skipTts || outgoingPayload.isError || isReplyPayloadTtsSupplement(outgoingPayload)
            ? outgoingPayload.text
            : mergeDeferredFinalText(state.accumulatedBlockTtsText, outgoingPayload.text)
          : undefined;
      const ttsPayload =
        finalVisibleTextSource !== undefined
          ? copyReplyPayloadMetadata(appliedTtsPayload, {
              ...appliedTtsPayload,
              text: cleanDeferredFinalText(finalVisibleTextSource) || undefined,
            })
          : appliedTtsPayload;
      const hasFinalTtsMedia = sendKind === "final" && isReplyPayloadTtsSupplement(ttsPayload);
      const isAnswerBearingFinal =
        sendKind === "final" &&
        (isCaptionedFinalTextPayload(outgoingPayload) ||
          (hasFinalTtsMedia && Boolean(ttsPayload.text?.trim())));

      const recordPendingDelivery = (tracksVisibleText: boolean) => {
        if (deliveredBlock && tracksVisibleText) {
          deliveredBlock.needsFinalDelivery = false;
        }
        // Coverage belongs to this payload. Hidden text and independent final audio
        // remain deliverable, and commentary never stands in for an answer.
        const pendingAnswer =
          tracksVisibleText &&
          sendKind !== "tool" &&
          !isStatusNotice &&
          !ttsPayload.isCommentary &&
          !ttsPayload.isReasoning;
        state.pendingAnswerDelivery ||= pendingAnswer;
        coverFinalBlockText(ttsPayload, finalBlocks);
        state.pendingFinalTtsMedia ||= hasFinalTtsMedia;
      };
      const recordFinalReply = () => {
        if (sendKind === "final") {
          state.deliveredFinalReply = true;
          // A generated final owns the answer; a block-derived send owns only its snapshot.
          state.deliveredAnswerFinalToUser ||=
            !recoveringBlock &&
            isAnswerBearingFinal &&
            (!transcriptSource || transcriptSource.kind === "final");
          state.deliveredFinalTtsMedia ||= hasFinalTtsMedia;
          coverFinalBlockText(ttsPayload, finalBlocks);
        }
      };
      const recordDeliveredReply = (tracksVisibleText: boolean) => {
        if (deliveredBlock) {
          deliveredBlock.delivered = sendKind === "final" ? "final" : "block";
        }
        if (
          (rawFinalText || hasFinalTtsMedia) &&
          transcriptSource &&
          transcriptSource.kind !== "final"
        ) {
          for (const block of finalBlocks) {
            block.delivered = "final";
          }
        } else if (transcriptFinalText) {
          state.accumulatedDeliveredFinalText = state.accumulatedDeliveredFinalText
            ? `${state.accumulatedDeliveredFinalText}\n${transcriptFinalText}`
            : transcriptFinalText;
        }
        recordFinalReply();
        if (tracksVisibleText) {
          state.deliveredVisibleText = true;
          if (deliveredBlock) {
            deliveredBlock.needsFinalDelivery = false;
          }
        }
      };

      if (params.shouldRouteToOriginating && params.originatingChannel && params.originatingTo) {
        const toolCallId = normalizeOptionalString(meta?.toolCallId);
        if (sendKind === "tool" && meta?.allowEdit === true && toolCallId) {
          const edited = await tryEditToolMessage(ttsPayload, toolCallId);
          if (edited) {
            return true;
          }
        }

        const tracksVisibleText = await shouldTreatDeliveredTextAsVisible({
          channel: routedChannel,
          kind: sendKind,
          text: ttsPayload.text,
        });
        const { routeReply } = await routeReplyRuntimeLoader.load();
        const threadId =
          params.originatingThreadId ??
          resolveRoutedDeliveryThreadId({
            ctx: params.ctx,
            sessionKey: deliverySessionKey,
          });
        const result = await routeReply({
          payload: ttsPayload,
          channel: params.originatingChannel,
          to: params.originatingTo,
          agentId: params.agentId,
          sessionKey: deliverySessionKey,
          ...(deliverySessionKey !== params.ctx.SessionKey
            ? { policySessionKey: params.ctx.SessionKey }
            : {}),
          accountId: resolvedAccountId,
          requesterSenderId: params.ctx.SenderId,
          requesterSenderName: params.ctx.SenderName,
          requesterSenderUsername: params.ctx.SenderUsername,
          requesterSenderE164: params.ctx.SenderE164,
          threadId,
          replyDelivery: routedReplyDelivery,
          cfg: params.cfg,
          abortSignal: params.abortSignal,
          mirror: false,
          replyKind: sendKind,
          runId: params.runId,
        });
        const outcome = resolveRoutedReplyDeliveryOutcome(result);
        const pending = outcome === "recovery-owned" || outcome === "failed-deliver";
        if (sendKind === "block") {
          setBlockReplyDelivery(Promise.resolve({ outcome, pending }), ttsPayload);
        }
        if (
          deliveredBlock &&
          result.suppressed &&
          (tracksVisibleText || (outcome === "channel-transform" && ttsPayload.text?.trim()))
        ) {
          // A channel veto covers its actual text even on a terminal-only surface.
          deliveredBlock.needsFinalDelivery = false;
        }
        if (pending) {
          recordPendingDelivery(tracksVisibleText);
          return true;
        }
        if (shouldRetryReplyDispatch(outcome) && hasFinalTtsMedia && ttsPayload.text?.trim()) {
          if (!result.suppressed) {
            logVerbose(
              `dispatch-acp: route-reply (acp/${sendKind}) failed: ${result.error ?? "unknown error"}`,
            );
          }
          return await deliver(
            "final",
            { text: ttsPayload.text },
            {
              skipTts: true,
              transcriptSource: transcriptSource ?? { kind: "final", text: rawFinalText ?? "" },
            },
          );
        }
        if (!result.delivered && !result.suppressed) {
          if (tracksVisibleText) {
            state.failedVisibleTextDelivery = true;
          }
          logVerbose(
            `dispatch-acp: route-reply (acp/${sendKind}) failed: ${result.error ?? "unknown error"}`,
          );
          return false;
        }
        if (result.suppressed) {
          if (outcome === "channel-transform") {
            coverFinalBlockText(ttsPayload, finalBlocks);
          }
          if (sendKind === "final") {
            state.deliveredFinalReply = true;
          }
          if (tracksVisibleText) {
            state.deliveredVisibleText = true;
          }
          return true;
        }
        if (!result.ok) {
          logVerbose(
            `dispatch-acp: route-reply (acp/${sendKind}) partially failed after delivery: ${
              result.error ?? "unknown error"
            }`,
          );
        }
        if (sendKind === "tool" && meta?.toolCallId && result.messageId) {
          state.toolMessageByCallId.set(meta.toolCallId, {
            channel: params.originatingChannel,
            accountId: resolvedAccountId,
            to: params.originatingTo,
            ...(threadId != null ? { threadId } : {}),
            messageId: result.messageId,
          });
        }
        recordDeliveredReply(tracksVisibleText);
        state.routedCounts[sendKind] += 1;
        return true;
      }

      if (sendKind === "tool" && hasPendingDirectBlockReplyDelivery) {
        // Block admission stays non-blocking; a later tool cannot overtake its visible delivery.
        hasPendingDirectBlockReplyDelivery = false;
        await waitForReplyDispatcherIdle(params.dispatcher, params.abortSignal);
      }

      const tracksVisibleText = await shouldTreatDeliveredTextAsVisible({
        channel: directChannel,
        kind: sendKind,
        text: ttsPayload.text,
      });
      const transcriptOutcome =
        sendKind !== "tool" ? captureReplyDispatchDeliveryOutcome(ttsPayload) : undefined;
      if (hasFinalTtsMedia && ttsPayload.text?.trim()) {
        attachReplyDispatchUndeliveredFallback(
          ttsPayload,
          buildCaptionedFinalTextFallback(ttsPayload),
        );
      }
      const delivered =
        sendKind === "tool"
          ? params.dispatcher.sendToolResult(ttsPayload)
          : sendKind === "block"
            ? params.dispatcher.sendBlockReply(ttsPayload)
            : params.dispatcher.sendFinalReply(ttsPayload);
      if (sendKind === "block") {
        setBlockReplyDelivery(
          delivered && transcriptOutcome?.isTracked()
            ? transcriptOutcome.promise.then((outcome) => ({
                outcome,
                pending: transcriptOutcome.hasPendingDelivery(),
              }))
            : Promise.resolve(
                delivered ? { outcome: "failed-deliver", pending: true } : { outcome: "cancelled" },
              ),
          ttsPayload,
        );
      }
      if (delivered && transcriptOutcome?.isTracked()) {
        const settlement = transcriptOutcome.promise.then((outcome) => {
          if (transcriptOutcome.hasPendingDelivery()) {
            recordPendingDelivery(tracksVisibleText);
          } else if (outcome === "delivered") {
            recordDeliveredReply(tracksVisibleText);
          } else {
            if (!shouldRetryReplyDispatch(outcome)) {
              // The dispatcher's terminal decision covers only text included in this attempt.
              if (deliveredBlock && ttsPayload.text?.trim()) {
                deliveredBlock.needsFinalDelivery = false;
              }
              coverFinalBlockText(ttsPayload, finalBlocks);
            }
            if (tracksVisibleText) {
              state.failedVisibleTextDelivery ||=
                outcome === "failed-before-deliver" || outcome === "failed-deliver";
              state.deliveredVisibleText ||= outcome === "failed-deliver";
            }
          }
        });
        state.pendingTranscriptOutcomes.push(settlement);
        if (sendKind === "final") {
          // Outer dispatch races cancellation. This owner retains the admitted final
          // until its receipt can safely decide fallback and cancelled-turn history.
          await settlement;
        }
      } else if (delivered) {
        recordFinalReply();
        if (tracksVisibleText) {
          state.queuedUntrackedVisibleTextDeliveries += 1;
          state.settledUntrackedVisibleText = false;
        }
      } else if (!delivered && tracksVisibleText) {
        state.failedVisibleTextDelivery = true;
      }
      if (sendKind === "block" && delivered) {
        hasPendingDirectBlockReplyDelivery = true;
      }
      return delivered;
    };
    const recordBlock = (preparedPayload: ReplyPayload, transcriptText?: string): AcpBlockText => {
      const block: AcpBlockText = {
        payload: preparedPayload,
        transcriptText,
        source: blockSource,
        needsFinalDelivery: Boolean(preparedPayload.text),
        deliver: (sendKind, skipTts) => sendPrepared(block.payload, block, skipTts, sendKind),
      };
      state.blockTexts.push(block);
      return block;
    };
    const blockText = rawBlockPayloadText ? recordBlock(visiblePayload, rawBlockText) : undefined;
    if (state.cleanBlockTtsDirectiveText && rawBlockText) {
      drainBlockText = state.cleanBlockTtsDirectiveText.hasBufferedDirectiveText()
        ? async (text) => {
            const tailPayload = buildAcpTextContinuation(visiblePayload, text);
            const tailBlock = recordBlock(tailPayload);
            const sendTail = async () => {
              setBlockReplyDelivery(Promise.resolve({ outcome: "cancelled" }), tailPayload);
              return params.abortSignal?.aborted ? false : await tailBlock.deliver("block", true);
            };
            return blockSource ? ((await blockSource.run(sendTail)) ?? false) : await sendTail();
          }
        : undefined;
    }
    const send = () =>
      blockText ? blockText.deliver("block") : sendPrepared(visiblePayload, undefined);
    return blockSource ? ((await blockSource.run(send)) ?? false) : await send();
  };

  return {
    startReplyLifecycle: startReplyLifecycleOnce,
    deliver,
    flushBlockText: async () => {
      if (params.abortSignal?.aborted) {
        return;
      }
      const text = state.cleanBlockTtsDirectiveText?.flush();
      const drain = drainBlockText;
      drainBlockText = undefined;
      pendingBlockSource?.setComplete(true);
      pendingBlockSource = undefined;
      if (text?.trim() && drain) {
        await drain(text);
      }
    },
    getAccumulatedVisibleBlockText: () => joinAcpBlockText(state.blockTexts),
    recoverBlockText: async (options?: { onlyUndelivered?: boolean }) => {
      if (!params.suppressBlockUserDelivery) {
        await settleDirectVisibleText();
      }
      return await recoverAcpBlockText(state, {
        ...params,
        channel: routedChannel ?? directChannel,
        onlyUndelivered: options?.onlyUndelivered,
      });
    },
    getAccumulatedBlockTtsText: () => state.accumulatedBlockTtsText,
    getAccumulatedTranscriptText: () =>
      state.accumulatedFinalText || getAcpBlockTranscriptText(state.blockTexts, pendingBlockSource),
    resolveAccumulatedDeliveredTranscriptText: async () => {
      // Transcript and fallback observers must await the same delivery settlements.
      await Promise.all(state.pendingTranscriptOutcomes);
      await Promise.all(
        state.blockTexts.flatMap((block) => (block.source ? [block.source.settle()] : [])),
      );
      return (
        state.accumulatedDeliveredFinalText ||
        getAcpBlockTranscriptText(state.blockTexts, pendingBlockSource, true)
      );
    },
    settleVisibleText: settleDirectVisibleText,
    hasDeliveredFinalReply: () => state.deliveredFinalReply,
    hasPendingAnswerDelivery: () => state.pendingAnswerDelivery,
    hasPendingFinalTtsMedia: () => state.pendingFinalTtsMedia,
    hasDeliveredAnswerFinalToUser: () => state.deliveredAnswerFinalToUser,
    hasDeliveredFinalTtsMedia: () => state.deliveredFinalTtsMedia,
    hasDeliveredVisibleText: () => state.deliveredVisibleText,
    hasFailedVisibleTextDelivery: () => state.failedVisibleTextDelivery,
    getDeliverySuppressionReason: () => state.suppressionReason,
    getRoutedCounts: () => ({ ...state.routedCounts }),
    applyRoutedCounts: (counts: Record<ReplyDispatchKind, number>) => {
      counts.tool += state.routedCounts.tool;
      counts.block += state.routedCounts.block;
      counts.final += state.routedCounts.final;
    },
  };
}
