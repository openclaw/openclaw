import {
  createMessageReceiptFromOutboundResults,
  listMessageReceiptPlatformIds,
  resolveMessageReceiptThreadId,
} from "../message/receipt.js";
import type { MessageReceipt } from "../message/types.js";
import type {
  ChannelDeliveryIntent,
  ChannelDeliveryOutcome,
  ChannelDeliveryResult,
} from "./delivery-outcome.js";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "./partial-delivery-error.js";

type ReceiptParams = Parameters<typeof createMessageReceiptFromOutboundResults>[0];

/** Accumulates accepted sends without recording text or identity from failed attempts. */
export function createChannelDeliveryAccumulator(
  params: Pick<ReceiptParams, "kind" | "replyToId"> = {},
) {
  const results: ReceiptParams["results"][number][] = [];
  const contents: string[] = [];
  const acceptedResult = (partial?: ChannelDeliveryOutcome) =>
    createAcceptedChannelDeliveryResult({
      ...params,
      results: [...results],
      ...(partial ? { deliveryResults: [partial] } : {}),
      content: [...contents, partial?.content].filter(Boolean).join("\n"),
    });
  return {
    get size() {
      return results.length;
    },
    add(result: ReceiptParams["results"][number], content?: string) {
      results.push(result);
      if (content) {
        contents.push(content);
      }
    },
    result() {
      return results.length > 0
        ? acceptedResult()
        : {
            visibleReplySent: false as const,
            suppression: { reason: "no_visible_result" as const },
          };
    },
    partialError(error: unknown): unknown {
      const partial = isChannelPartialDeliveryError(error) ? error.deliveryResult : undefined;
      return results.length > 0 || partial
        ? createChannelPartialDeliveryError(error, acceptedResult(partial))
        : error;
    },
  };
}

/** Aggregates caller-confirmed sends, preserving nested receipts before legacy message IDs. */
export function createAcceptedChannelDeliveryResult(
  params: Pick<ReceiptParams, "kind" | "replyToId"> & {
    results?: ReceiptParams["results"];
    deliveryResults?: readonly ChannelDeliveryOutcome[];
    content?: string;
  },
): {
  messageIds: string[];
  receipt: MessageReceipt;
  visibleReplySent: true;
  content?: string;
} {
  const { deliveryResults, content, ...receiptParams } = params;
  const results = deliveryResults
    ? [
        ...(receiptParams.results ?? []),
        ...deliveryResults.flatMap((result): ReceiptParams["results"] =>
          result.receipt
            ? [{ receipt: result.receipt }]
            : (result.messageIds ?? []).map((messageId) => ({ messageId })),
        ),
      ]
    : (receiptParams.results ?? []);
  const receipt = createMessageReceiptFromOutboundResults({ ...receiptParams, results });
  return {
    messageIds: listMessageReceiptPlatformIds(receipt),
    receipt,
    visibleReplySent: true,
    ...(content === undefined ? {} : { content }),
  };
}

/** Builds a typed non-visible channel outcome without transport identity. */
export function createSuppressedChannelDeliveryResult(params: {
  reason: NonNullable<ChannelDeliveryResult["suppression"]>["reason"];
  cancelReason?: string;
  metadata?: Record<string, unknown>;
}): ChannelDeliveryResult {
  return {
    visibleReplySent: false,
    suppression: {
      reason: params.reason,
      ...(params.cancelReason ? { cancelReason: params.cancelReason } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    },
  };
}

/** Converts a normalized message receipt into the delivery result shape used by channel turns. */
export function createChannelDeliveryResultFromReceipt(params: {
  receipt: MessageReceipt;
  threadId?: string;
  replyToId?: string;
  visibleReplySent?: boolean;
  content?: string;
  deliveryIntent?: ChannelDeliveryIntent;
}): ChannelDeliveryResult {
  const messageIds = listMessageReceiptPlatformIds(params.receipt);
  const threadId = resolveMessageReceiptThreadId(params.receipt, params.threadId);
  return {
    ...(messageIds.length > 0 ? { messageIds } : {}),
    receipt: params.receipt,
    ...(threadId ? { threadId } : {}),
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
    ...(params.visibleReplySent === undefined ? {} : { visibleReplySent: params.visibleReplySent }),
    ...(params.content === undefined ? {} : { content: params.content }),
    ...(params.deliveryIntent ? { deliveryIntent: params.deliveryIntent } : {}),
  };
}

export {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
  type ChannelPartialDeliveryError,
} from "./partial-delivery-error.js";
