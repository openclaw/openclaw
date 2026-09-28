import { resolveAcpThreadSessionDetailLines } from "@openclaw/acp-core/runtime/session-identifiers";
import {
  isSessionIdentityPending,
  resolveSessionIdentityFromMeta,
} from "@openclaw/acp-core/runtime/session-identity";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { createLazyPromise } from "../../shared/lazy-promise.js";
import { cleanDeferredFinalText } from "../../tts/captioned-final.js";
import { resolveStatusTtsSnapshot } from "../../tts/status-config.js";
import { resolveConfiguredTtsMode } from "../../tts/tts-config.js";
import { markReplyPayloadAsTtsSupplement } from "../reply-payload.js";
import type { AcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import { needsTtsFallback } from "./dispatch-from-config.finalize.js";

const loadDispatchAcpTtsRuntime = createLazyPromise(() => import("../../tts/tts.runtime.js"));
const loadDispatchAcpManagerRuntime = createLazyPromise(
  () => import("./dispatch-acp-manager.runtime.js"),
);

export async function finalizeAcpTurnOutput(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  delivery: AcpDispatchDeliveryCoordinator;
  inboundAudio: boolean;
  sessionTtsAuto?: TtsAutoMode;
  ttsChannel?: string;
  ttsAccountId?: string;
  shouldDeferVisibleTextForTts: boolean;
  shouldEmitResolvedIdentityNotice: boolean;
  abortSignal?: AbortSignal;
}): Promise<boolean> {
  const ttsMode = resolveConfiguredTtsMode(params.cfg, {
    agentId: params.agentId,
    channelId: params.ttsChannel,
    accountId: params.ttsAccountId,
  });
  const accumulatedBlockTtsText = params.delivery.getAccumulatedBlockTtsText();
  const hasAccumulatedBlockText = accumulatedBlockTtsText.trim().length > 0;
  const ttsStatus = resolveStatusTtsSnapshot({
    cfg: params.cfg,
    sessionAuto: params.sessionTtsAuto,
    agentId: params.agentId,
    channelId: params.ttsChannel,
    accountId: params.ttsAccountId,
  });
  const canAttemptFinalTts =
    ttsStatus != null && !(ttsStatus.autoMode === "inbound" && !params.inboundAudio);
  const shouldDeferVisibleTextForTts =
    params.shouldDeferVisibleTextForTts &&
    ttsMode === "final" &&
    hasAccumulatedBlockText &&
    canAttemptFinalTts;
  const accumulatedVisibleBlockText = shouldDeferVisibleTextForTts
    ? cleanDeferredFinalText(accumulatedBlockTtsText)
    : params.delivery.getAccumulatedVisibleBlockText();
  if (!shouldDeferVisibleTextForTts) {
    await params.delivery.settleVisibleText();
  }
  if (params.abortSignal?.aborted) {
    return false;
  }
  let queuedFinal =
    params.delivery.hasPendingAnswerDelivery() ||
    params.delivery.hasPendingFinalTtsMedia() ||
    (params.delivery.hasDeliveredVisibleText() && !params.delivery.hasFailedVisibleTextDelivery());

  if (
    ttsMode === "final" &&
    hasAccumulatedBlockText &&
    canAttemptFinalTts &&
    !params.delivery.hasPendingFinalTtsMedia() &&
    !params.delivery.hasDeliveredFinalTtsMedia()
  ) {
    try {
      const { maybeApplyTtsToPayload } = await loadDispatchAcpTtsRuntime();
      if (params.abortSignal?.aborted) {
        return queuedFinal;
      }
      const ttsSyntheticReply = await maybeApplyTtsToPayload({
        payload: { text: accumulatedBlockTtsText },
        cfg: params.cfg,
        channel: params.ttsChannel,
        kind: "final",
        inboundAudio: params.inboundAudio,
        ttsAuto: params.sessionTtsAuto,
        agentId: params.agentId,
        accountId: params.ttsAccountId,
      });
      if (ttsSyntheticReply.mediaUrl) {
        const finalTtsPayload = markReplyPayloadAsTtsSupplement(
          shouldDeferVisibleTextForTts
            ? {
                ...ttsSyntheticReply,
                text: accumulatedVisibleBlockText || undefined,
                trustedLocalMedia: true,
              }
            : { ...ttsSyntheticReply, text: undefined, trustedLocalMedia: true },
          accumulatedBlockTtsText,
          shouldDeferVisibleTextForTts ? undefined : { visibleTextAlreadyDelivered: true },
        );
        const delivered = await params.delivery.deliver("final", finalTtsPayload, {
          transcriptSource: { kind: "blocks" },
        });
        queuedFinal = queuedFinal || delivered;
      } else if (
        (shouldDeferVisibleTextForTts && ttsSyntheticReply.text?.trim()) ||
        needsTtsFallback(true, accumulatedVisibleBlockText, ttsSyntheticReply.text)
      ) {
        const delivered = await params.delivery.deliver(
          "final",
          { text: ttsSyntheticReply.text },
          { skipTts: true, transcriptSource: { kind: "blocks" } },
        );
        queuedFinal = queuedFinal || delivered;
      }
    } catch (err) {
      logVerbose(`dispatch-acp: accumulated ACP block TTS failed: ${formatErrorMessage(err)}`);
    }
  }

  // Some ACP parent surfaces only expose terminal replies, so block routing alone is not enough
  // to prove the final result was visible to the user.
  queuedFinal =
    (await params.delivery.recoverBlockText({ onlyUndelivered: ttsMode === "all" })) || queuedFinal;

  if (params.shouldEmitResolvedIdentityNotice) {
    const { readAcpSessionEntryAsync } = await loadDispatchAcpManagerRuntime();
    const currentSession = await readAcpSessionEntryAsync({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
    if (params.abortSignal?.aborted) {
      return queuedFinal;
    }
    const currentMeta = currentSession?.acp;
    const identityAfterTurn = resolveSessionIdentityFromMeta(currentMeta);
    if (!isSessionIdentityPending(identityAfterTurn)) {
      const resolvedDetails = resolveAcpThreadSessionDetailLines({
        sessionKey: params.sessionKey,
        meta: currentMeta,
      });
      if (resolvedDetails.length > 0) {
        const delivered = await params.delivery.deliver("final", {
          text: prefixSystemMessage(["Session ids resolved.", ...resolvedDetails].join("\n")),
          isStatusNotice: true,
        });
        queuedFinal = queuedFinal || delivered;
      }
    }
  }

  return queuedFinal;
}
