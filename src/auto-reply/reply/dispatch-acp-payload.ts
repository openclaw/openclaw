// Prepares ACP reply payloads and applies TTS before delivery.
import {
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { createChannelReplyTransform } from "../../channels/message/reply-transform.js";
import type { ChannelMessagingAdapter } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TtsAutoMode } from "../../config/types.tts.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { resolveStatusTtsSnapshot } from "../../tts/status-config.js";
import { resolveConfiguredTtsMode } from "../../tts/tts-config.js";
import { copyReplyPayloadMetadata, isReplyPayloadStatusNotice } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { hasBlockReplyDeliveryCustody } from "./block-reply-delivery.js";
import type { BlockReplySource } from "./block-reply-source.types.js";
import type { AcpBlockText, AcpDispatchDeliveryState } from "./dispatch-acp-delivery.types.js";
import { normalizeReplyPayloadOutcome } from "./normalize-reply.js";
import { prepareReplyPayloadForDispatcher } from "./reply-dispatcher.js";
import type { ReplyDispatchKind, ReplyDispatcher } from "./reply-dispatcher.types.js";

const dispatchAcpTtsRuntimeLoader = createLazyImportLoader(
  () => import("../../tts/tts.runtime.js"),
);

export function prepareAcpDeliveryPayload(params: {
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  kind: ReplyDispatchKind;
  payload: ReplyPayload;
  routed: boolean;
  messaging?: ChannelMessagingAdapter;
  accountId?: string;
}) {
  if (!params.routed) {
    return prepareReplyPayloadForDispatcher(params.dispatcher, params.kind, params.payload);
  }
  return normalizeReplyPayloadOutcome(params.payload, {
    transformReplyPayload: createChannelReplyTransform({
      messaging: params.messaging,
      cfg: params.cfg,
      accountId: params.accountId,
    }),
  });
}

export async function maybeApplyAcpTts(params: {
  payload: ReplyPayload;
  cfg: OpenClawConfig;
  agentId?: string;
  channel?: string;
  accountId?: string;
  kind: ReplyDispatchKind;
  inboundAudio: boolean;
  ttsAuto?: TtsAutoMode;
  skipTts?: boolean;
}): Promise<ReplyPayload> {
  if (params.skipTts) {
    return params.payload;
  }
  if (isReplyPayloadStatusNotice(params.payload)) {
    return params.payload;
  }
  const ttsStatus = resolveStatusTtsSnapshot({
    cfg: params.cfg,
    sessionAuto: params.ttsAuto,
    agentId: params.agentId,
    channelId: params.channel,
    accountId: params.accountId,
  });
  if (!ttsStatus) {
    return params.payload;
  }
  if (ttsStatus.autoMode === "inbound" && !params.inboundAudio) {
    return params.payload;
  }
  if (
    params.kind !== "final" &&
    resolveConfiguredTtsMode(params.cfg, {
      agentId: params.agentId,
      channelId: params.channel,
      accountId: params.accountId,
    }) === "final"
  ) {
    return params.payload;
  }
  const { maybeApplyTtsToPayload } = await dispatchAcpTtsRuntimeLoader.load();
  const applied = await maybeApplyTtsToPayload({
    payload: params.payload,
    cfg: params.cfg,
    channel: params.channel,
    kind: params.kind,
    inboundAudio: params.inboundAudio,
    ttsAuto: params.ttsAuto,
    agentId: params.agentId,
    accountId: params.accountId,
  });
  return copyReplyPayloadMetadata(params.payload, applied);
}

const channelPluginRuntimeLoader = createLazyImportLoader(
  () => import("../../channels/plugins/index.js"),
);

export async function shouldTreatDeliveredTextAsVisible(params: {
  channel: string | undefined;
  kind: ReplyDispatchKind;
  text: string | undefined;
}): Promise<boolean> {
  if (!normalizeOptionalString(params.text)) {
    return false;
  }
  if (params.kind === "final") {
    return true;
  }
  const channelId = normalizeOptionalLowercaseString(params.channel);
  if (!channelId) {
    return false;
  }
  const { getChannelPlugin } = await channelPluginRuntimeLoader.load();
  const outbound = getChannelPlugin(channelId)?.outbound;
  const visibilityOverride =
    outbound?.shouldTreatDeliveredTextAsVisible ?? outbound?.shouldTreatRoutedTextAsVisible;
  if (visibilityOverride) {
    return visibilityOverride({
      kind: params.kind,
      text: params.text,
    });
  }
  return false;
}

export function getAcpBlockTranscriptText(
  blocks: AcpBlockText[],
  pendingBlockSource: BlockReplySource | undefined,
  confirmedOnly = false,
) {
  const deliveredSources = new Set(
    blocks.filter((block) => block.delivered).map((block) => block.source),
  );
  const recoveredSources = new Set(
    blocks.filter((block) => block.delivered === "final").map((block) => block.source),
  );
  // Final recovery confirms a source only after its buffered and visible parts are covered.
  recoveredSources.delete(pendingBlockSource);
  for (const block of blocks) {
    if (block.payload.text && !block.delivered) {
      recoveredSources.delete(block.source);
    }
  }
  return blocks
    .flatMap((block) => {
      const sourceConfirmed = block.source
        ? (block.source.complete && deliveredSources.has(block.source)) ||
          recoveredSources.has(block.source)
        : block.delivered;
      const text =
        !confirmedOnly || sourceConfirmed
          ? block.transcriptText
          : block.delivered
            ? block.payload.text
            : undefined;
      return text ? [text] : [];
    })
    .join("\n");
}

export function joinAcpBlockText(blocks: AcpBlockText[]) {
  let text = "";
  let previousSource: BlockReplySource | undefined;
  for (const block of blocks) {
    if (block.payload.text) {
      if (text && (!block.source || block.source !== previousSource)) {
        text += "\n";
      }
      text += block.payload.text;
      previousSource = block.source;
    }
  }
  return text;
}

export async function recoverAcpBlockText(
  state: AcpDispatchDeliveryState,
  params: {
    shouldRouteToOriginating: boolean;
    suppressBlockUserDelivery?: boolean;
    abortSignal?: AbortSignal;
    channel?: string;
    onlyUndelivered?: boolean;
  },
) {
  if (
    state.deliveredAnswerFinalToUser ||
    (!params.shouldRouteToOriginating &&
      state.queuedUntrackedVisibleTextDeliveries > 0 &&
      !params.suppressBlockUserDelivery &&
      state.deliveredVisibleText &&
      !state.failedVisibleTextDelivery)
  ) {
    return false;
  }
  const blocks = state.blockTexts.filter(
    (block) => block.needsFinalDelivery && (!params.onlyUndelivered || !block.delivered),
  );
  let queued = false;
  for (const block of blocks) {
    if (params.abortSignal?.aborted) {
      break;
    }
    if (
      block.source &&
      !params.suppressBlockUserDelivery &&
      (await shouldTreatDeliveredTextAsVisible({
        channel: params.channel,
        kind: "block",
        text: block.payload.text,
      })) &&
      hasBlockReplyDeliveryCustody(await block.source.settle())
    ) {
      continue;
    }
    if (params.abortSignal?.aborted) {
      break;
    }
    queued = (await block.deliver("final", true)) || queued;
    if (block.delivered !== "final") {
      break;
    }
  }
  return queued;
}

export function buildAcpTextContinuation(
  payload: ReplyPayload,
  text: string | undefined,
): ReplyPayload {
  return copyReplyPayloadMetadata(payload, {
    text,
    replyToId: payload.replyToId,
    replyToTag: payload.replyToTag,
    replyToCurrent: payload.replyToCurrent,
    isCommentary: payload.isCommentary,
    isReasoning: payload.isReasoning,
  });
}
