import {
  chunkByParagraph,
  chunkMarkdownTextWithMode,
  type ChunkMode,
} from "../../auto-reply/chunk.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { ReplyToOverride } from "./reply-policy.js";

/** Per-send overrides carried from outbound planning into channel delivery. */
export type OutboundMessageSendOverrides = ReplyToOverride & {
  threadId?: string | number | null;
  audioAsVoice?: boolean;
  forceDocument?: boolean;
  formatting?: OutboundDeliveryFormattingOptions;
  /** Stable zero-based platform-send index within one durable payload. */
  deliveryPartIndex?: number;
  /** Exact platform-send count for this payload. */
  deliveryPartCount?: number;
};

type OutboundTextMessageUnit = {
  kind: "text";
  text: string;
  overrides: OutboundMessageSendOverrides;
};

type OutboundMessageChunker = (
  text: string,
  limit: number,
  ctx?: { formatting?: OutboundDeliveryFormattingOptions },
) => string[];

type PlanReplyToConsumption = <T extends OutboundMessageSendOverrides>(overrides: T) => T;

type DurableMediaFanoutContext = {
  channel: string;
  requiredUnknownSendReconciliation?: boolean;
  renderedBatchPlan?: { items: Array<{ mediaUrls: readonly string[] }> };
};

export function assertStableMediaFanout(
  params: DurableMediaFanoutContext,
  payloadIndex: number,
  originalMediaCount: number,
  effective: { mediaUrls: readonly unknown[] },
): void {
  if (!params.requiredUnknownSendReconciliation) {
    return;
  }
  const plannedMediaCount =
    params.renderedBatchPlan?.items[payloadIndex]?.mediaUrls.length ?? originalMediaCount;
  if (plannedMediaCount !== effective.mediaUrls.length) {
    throw new Error(
      `Required durable message send changed platform fan-out after outbound transforms for ${params.channel}`,
    );
  }
}

function withPlannedReplyTo(
  overrides: OutboundMessageSendOverrides,
  consumeReplyTo?: PlanReplyToConsumption,
): OutboundMessageSendOverrides {
  // Reply-to policies can be single-use; clone overrides before consuming the implicit slot.
  return consumeReplyTo ? consumeReplyTo({ ...overrides }) : { ...overrides };
}

/** Plans text sends, preserving reply-to policy across chunked delivery units. */
export function planOutboundTextMessageUnits(params: {
  text: string;
  overrides: OutboundMessageSendOverrides;
  chunker?: OutboundMessageChunker | null;
  chunkerMode?: "text" | "markdown";
  chunkedTextFormatting?: OutboundDeliveryFormattingOptions;
  textLimit?: number;
  chunkMode?: ChunkMode;
  formatting?: OutboundDeliveryFormattingOptions;
  consumeReplyTo?: PlanReplyToConsumption;
}): OutboundTextMessageUnit[] {
  const planTextUnit = (
    text: string,
    deliveryPartIndex: number,
    chunkedTextFormatting?: OutboundDeliveryFormattingOptions,
  ): OutboundTextMessageUnit => {
    const overrides = {
      ...withPlannedReplyTo(params.overrides, params.consumeReplyTo),
      deliveryPartIndex,
    };
    return {
      kind: "text",
      text,
      overrides: chunkedTextFormatting
        ? { ...overrides, formatting: { ...overrides.formatting, ...chunkedTextFormatting } }
        : overrides,
    };
  };

  const withDeliveryTopology = (units: OutboundTextMessageUnit[]): OutboundTextMessageUnit[] => {
    const deliveryPartCount = units.length;
    // These units are planner-owned until return; finalize them in place rather
    // than cloning every chunk solely to attach the shared fan-out count.
    for (const unit of units) {
      unit.overrides.deliveryPartCount = deliveryPartCount;
    }
    return units;
  };

  if (!params.chunker || params.textLimit === undefined) {
    return withDeliveryTopology([planTextUnit(params.text, 0)]);
  }

  // In newline mode the channel chunker below owns length splits. Splitting a long
  // paragraph here would cut fenced code before a fence-aware chunker sees it.
  const blockChunks =
    params.chunkMode !== "newline"
      ? [params.text]
      : (params.chunkerMode ?? "text") === "markdown"
        ? chunkMarkdownTextWithMode(params.text, params.textLimit, "newline")
        : chunkByParagraph(params.text, params.textLimit, { splitLongParagraphs: false });
  if (!blockChunks.length && params.text) {
    blockChunks.push(params.text);
  }

  const units: OutboundTextMessageUnit[] = [];
  for (const blockChunk of blockChunks) {
    const chunks = params.formatting
      ? params.chunker(blockChunk, params.textLimit, { formatting: params.formatting })
      : params.chunker(blockChunk, params.textLimit);
    for (const chunk of chunks.length === 0 && blockChunk ? [blockChunk] : chunks) {
      units.push(planTextUnit(chunk, units.length, params.chunkedTextFormatting));
    }
  }
  return withDeliveryTopology(units);
}

/** Plans media sends with a caption only on the leading media unit. */
export function planOutboundMediaMessageUnits(params: {
  caption: string;
  mediaUrls: readonly string[];
  overrides: OutboundMessageSendOverrides;
  consumeReplyTo?: PlanReplyToConsumption;
}) {
  const deliveryPartCount = params.mediaUrls.length;
  return params.mediaUrls.map((mediaUrl, index) => ({
    kind: "media" as const,
    mediaUrl,
    ...(index === 0 ? { caption: params.caption } : {}),
    overrides: {
      ...withPlannedReplyTo(params.overrides, params.consumeReplyTo),
      deliveryPartIndex: index,
      deliveryPartCount,
    },
  }));
}
