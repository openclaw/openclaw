import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type {
  RenderedMessageBatch,
  RenderedMessageBatchPlan,
  RenderedMessageBatchPlanItem,
  RenderedMessageBatchPlanKind,
} from "./types.js";

function createRenderedMessageBatchPlanItem(
  payload: ReplyPayload,
  index: number,
): RenderedMessageBatchPlanItem {
  const text = payload.text?.trim();
  const mediaUrls = normalizeTrimmedStringList(payload.mediaUrls);
  const mediaUrl = payload.mediaUrl?.trim();
  if (mediaUrl && !mediaUrls.includes(mediaUrl)) {
    mediaUrls.unshift(mediaUrl);
  }
  const presentationBlockCount = payload.presentation?.blocks?.length ?? 0;
  const kinds: RenderedMessageBatchPlanKind[] = [];
  if (text) {
    kinds.push("text");
  }
  if (mediaUrls.length > 0) {
    kinds.push(payload.audioAsVoice ? "voice" : "media");
  }
  if (presentationBlockCount > 0 || payload.presentation?.title?.trim()) {
    kinds.push("presentation");
  }
  if (payload.interactive) {
    kinds.push("interactive");
  }
  if (payload.channelData || payload.location) {
    kinds.push("channelData");
  }
  return {
    index,
    kinds: kinds.length > 0 ? kinds : ["empty"],
    ...(text ? { text } : {}),
    mediaUrls,
    ...(payload.audioAsVoice && mediaUrls.length > 0 ? { audioAsVoice: true } : {}),
    ...(presentationBlockCount > 0 ? { presentationBlockCount } : {}),
    ...(payload.interactive ? { hasInteractive: true } : {}),
    ...(payload.channelData || payload.location ? { hasChannelData: true } : {}),
  };
}

export function createRenderedMessageBatchPlan(
  payloads: readonly ReplyPayload[],
): RenderedMessageBatchPlan {
  const items = payloads.map(createRenderedMessageBatchPlanItem);
  return items.reduce<RenderedMessageBatchPlan>(
    (plan, item) => {
      plan.payloadCount += 1;
      plan.textCount += item.text ? 1 : 0;
      plan.mediaCount += item.mediaUrls.length;
      plan.voiceCount += item.audioAsVoice ? 1 : 0;
      plan.presentationCount += item.kinds.includes("presentation") ? 1 : 0;
      plan.interactiveCount += item.hasInteractive ? 1 : 0;
      plan.channelDataCount += item.hasChannelData ? 1 : 0;
      return plan;
    },
    {
      payloadCount: 0,
      textCount: 0,
      mediaCount: 0,
      voiceCount: 0,
      presentationCount: 0,
      interactiveCount: 0,
      channelDataCount: 0,
      items,
    },
  );
}

export function createRenderedMessageBatch(
  payloads: ReplyPayload[],
): RenderedMessageBatch<ReplyPayload> {
  return {
    payloads,
    plan: createRenderedMessageBatchPlan(payloads),
  };
}
