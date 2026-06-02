import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { OutboundDeliveryResult } from "../../infra/outbound/deliver-types.js";
import {
  isOutboundDeliveryError,
  type OutboundPayloadDeliveryOutcome,
  type OutboundPayloadDeliverySuppressionReason,
} from "../../infra/outbound/deliver-types.js";
import {
  deliverOutboundPayloadsInternal,
  type DeliverOutboundPayloadsParams,
  type OutboundDeliveryIntent,
} from "../../infra/outbound/deliver.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createLiveMessageState, markLiveMessagePreviewUpdated } from "./live.js";
import { createMessageReceiptFromOutboundResults } from "./receipt.js";
import { createRenderedMessageBatch } from "./rendered-batch.js";
import type {
  DurableMessageSendIntent,
  LiveMessageState,
  MessageDurabilityPolicy,
  MessageReceipt,
  MessageSendContext,
  RenderedMessageBatch,
} from "./types.js";

const log = createSubsystemLogger("channels/message/send");

export type DurableMessageBatchSendParams = Omit<
  DeliverOutboundPayloadsParams,
  "abortSignal" | "onDeliveryIntent" | "payloads" | "queuePolicy"
> & {
  /** Reply payloads to render and send as one logical durable batch. */
  payloads: ReplyPayload[];
  /** Retry attempt number surfaced through the send context. */
  attempt?: number;
  /** Preferred cancellation signal for durable delivery. */
  signal?: AbortSignal;
  /** @deprecated Use `signal`. */
  abortSignal?: AbortSignal;
  /** Receipt from a previous preview/send attempt, when retrying. */
  previousReceipt?: MessageReceipt;
};

export type DurableMessageSuppressionReason =
  | OutboundPayloadDeliverySuppressionReason
  | "no_visible_result";

export type DurableMessageFailureStage = "platform_send" | "queue" | "unknown";

export type DurableMessagePayloadDeliveryOutcome =
  | {
      /** Payload index within the rendered batch. */
      index: number;
      status: "sent";
      /** Raw platform results produced for this payload. */
      results: OutboundDeliveryResult[];
    }
  | {
      /** Payload index within the rendered batch. */
      index: number;
      status: "suppressed";
      /** Why no visible platform message was sent. */
      reason: DurableMessageSuppressionReason;
      hookEffect?: {
        cancelReason?: string;
        metadata?: Record<string, unknown>;
      };
    }
  | {
      /** Payload index within the rendered batch. */
      index: number;
      status: "failed";
      error: unknown;
      /** True when the platform may already have accepted a prior payload. */
      sentBeforeError: boolean;
      /** Phase where delivery failed or became ambiguous. */
      stage: DurableMessageFailureStage;
    };

export type DurableMessageBatchSendResult =
  | {
      status: "sent";
      results: OutboundDeliveryResult[];
      receipt: MessageReceipt;
      deliveryIntent?: OutboundDeliveryIntent;
      payloadOutcomes?: DurableMessagePayloadDeliveryOutcome[];
    }
  | {
      status: "suppressed";
      results: [];
      receipt: MessageReceipt;
      deliveryIntent?: OutboundDeliveryIntent;
      reason: DurableMessageSuppressionReason;
      payloadOutcomes?: DurableMessagePayloadDeliveryOutcome[];
    }
  | {
      status: "partial_failed";
      results: OutboundDeliveryResult[];
      receipt: MessageReceipt;
      error: unknown;
      sentBeforeError: true;
      deliveryIntent?: OutboundDeliveryIntent;
      payloadOutcomes?: DurableMessagePayloadDeliveryOutcome[];
    }
  | {
      status: "failed";
      error: unknown;
      stage?: DurableMessageFailureStage;
      payloadOutcomes?: DurableMessagePayloadDeliveryOutcome[];
    };

export type DurableMessageDeliveryOutcome = DurableMessageBatchSendResult;

const neverAbortedSignal = new AbortController().signal;

function toDurableMessageIntent(
  intent: OutboundDeliveryIntent,
  renderedBatch: RenderedMessageBatch<ReplyPayload>,
): DurableMessageSendIntent<ReplyPayload> {
  return {
    id: intent.id,
    channel: intent.channel,
    to: intent.to,
    ...(intent.accountId ? { accountId: intent.accountId } : {}),
    durability: intent.queuePolicy === "required" ? "required" : "best_effort",
    renderedBatch,
  };
}

function toDurablePayloadOutcome(
  outcome: OutboundPayloadDeliveryOutcome,
): DurableMessagePayloadDeliveryOutcome {
  return outcome;
}

function toDurablePayloadOutcomes(
  outcomes: readonly OutboundPayloadDeliveryOutcome[],
): DurableMessagePayloadDeliveryOutcome[] {
  return outcomes.map((outcome) => toDurablePayloadOutcome(outcome));
}

export type DurableMessageSendContextParams = DurableMessageBatchSendParams & {
  durability?: Exclude<MessageDurabilityPolicy, "disabled">;
  /** Live preview state carried across render/send/edit/commit hooks. */
  preview?: LiveMessageState<ReplyPayload>;
  onPreviewUpdate?: (
    rendered: RenderedMessageBatch<ReplyPayload>,
    state: LiveMessageState<ReplyPayload>,
  ) => Promise<LiveMessageState<ReplyPayload>> | LiveMessageState<ReplyPayload>;
  onEditReceipt?: (
    receipt: MessageReceipt,
    rendered: RenderedMessageBatch<ReplyPayload>,
  ) => Promise<MessageReceipt> | MessageReceipt;
  onDeleteReceipt?: (receipt: MessageReceipt) => Promise<void> | void;
  onCommitReceipt?: (receipt: MessageReceipt) => Promise<void> | void;
  onSendFailure?: (error: unknown) => Promise<void> | void;
};

export type DurableMessageSendContext = MessageSendContext<
  ReplyPayload,
  DurableMessageBatchSendResult
>;

export async function withDurableMessageSendContext<T>(
  params: DurableMessageSendContextParams,
  run: (ctx: DurableMessageSendContext) => Promise<T>,
): Promise<T> {
  let deliveryIntent: OutboundDeliveryIntent | undefined;
  const {
    attempt,
    durability,
    onDeleteReceipt,
    onEditReceipt,
    onCommitReceipt,
    onPreviewUpdate,
    onSendFailure,
    onPayloadDeliveryOutcome,
    payloads,
    preview,
    previousReceipt,
    signal,
    abortSignal,
    ...deliveryParams
  } = params;
  const effectiveSignal = signal ?? abortSignal;
  const queuePolicy = durability === "best_effort" ? "best_effort" : "required";
  let liveState = preview ?? createLiveMessageState<ReplyPayload>();
  const ctx: DurableMessageSendContext = {
    id: `${params.channel}:${params.to}`,
    channel: params.channel,
    to: params.to,
    ...(params.accountId ? { accountId: params.accountId } : {}),
    durability: durability ?? "required",
    attempt: attempt ?? 1,
    signal: effectiveSignal ?? neverAbortedSignal,
    ...(previousReceipt ? { previousReceipt } : {}),
    preview: liveState,
    render: async (): Promise<RenderedMessageBatch<ReplyPayload>> =>
      createRenderedMessageBatch(payloads),
    previewUpdate: async (rendered): Promise<LiveMessageState<ReplyPayload>> => {
      liveState = onPreviewUpdate
        ? await onPreviewUpdate(rendered, liveState)
        : markLiveMessagePreviewUpdated(liveState, rendered);
      ctx.preview = liveState;
      return liveState;
    },
    send: async (rendered): Promise<DurableMessageBatchSendResult> => {
      const payloadOutcomes: OutboundPayloadDeliveryOutcome[] = [];
      const durablePayloadOutcomes = (): DurableMessagePayloadDeliveryOutcome[] =>
        toDurablePayloadOutcomes(payloadOutcomes);
      try {
        const results = await deliverOutboundPayloadsInternal({
          ...deliveryParams,
          payloads: rendered.payloads,
          renderedBatchPlan: rendered.plan,
          queuePolicy,
          ...(effectiveSignal ? { abortSignal: effectiveSignal } : {}),
          onPayloadDeliveryOutcome: (outcome) => {
            payloadOutcomes.push(outcome);
            onPayloadDeliveryOutcome?.(outcome);
          },
          onDeliveryIntent: (intent) => {
            deliveryIntent = intent;
            ctx.intent = toDurableMessageIntent(intent, rendered);
          },
        });
        const receipt = createMessageReceiptFromOutboundResults({
          results,
          threadId: params.threadId == null ? undefined : String(params.threadId),
          replyToId: params.replyToId ?? undefined,
        });
        const failedOutcome = payloadOutcomes.find((outcome) => outcome.status === "failed");
        if (failedOutcome) {
          if (results.length > 0) {
            return {
              status: "partial_failed",
              results,
              receipt,
              error: failedOutcome.error,
              sentBeforeError: true,
              ...(deliveryIntent ? { deliveryIntent } : {}),
              ...(payloadOutcomes.length > 0 ? { payloadOutcomes: durablePayloadOutcomes() } : {}),
            };
          }
          return {
            status: "failed",
            error: failedOutcome.error,
            stage: failedOutcome.stage,
            ...(payloadOutcomes.length > 0 ? { payloadOutcomes: durablePayloadOutcomes() } : {}),
          };
        }
        if (results.length === 0) {
          return {
            status: "suppressed",
            results: [],
            receipt,
            ...(deliveryIntent ? { deliveryIntent } : {}),
            reason:
              payloadOutcomes.find((outcome) => outcome.status === "suppressed")?.reason ??
              "no_visible_result",
            ...(payloadOutcomes.length > 0 ? { payloadOutcomes: durablePayloadOutcomes() } : {}),
          };
        }
        return {
          status: "sent",
          results,
          receipt,
          ...(deliveryIntent ? { deliveryIntent } : {}),
          ...(payloadOutcomes.length > 0 ? { payloadOutcomes: durablePayloadOutcomes() } : {}),
        };
      } catch (error: unknown) {
        if (isOutboundDeliveryError(error)) {
          if (error.results.length > 0) {
            const receipt = createMessageReceiptFromOutboundResults({
              results: error.results,
              threadId: params.threadId == null ? undefined : String(params.threadId),
              replyToId: params.replyToId ?? undefined,
            });
            return {
              status: "partial_failed",
              results: error.results,
              receipt,
              error,
              sentBeforeError: true,
              ...(deliveryIntent ? { deliveryIntent } : {}),
              ...(error.payloadOutcomes.length > 0
                ? { payloadOutcomes: toDurablePayloadOutcomes(error.payloadOutcomes) }
                : {}),
            };
          }
          return {
            status: "failed",
            error,
            stage: error.stage,
            ...(error.payloadOutcomes.length > 0
              ? { payloadOutcomes: toDurablePayloadOutcomes(error.payloadOutcomes) }
              : {}),
          };
        }
        return { status: "failed", error };
      }
    },
    edit: async (receipt, rendered): Promise<MessageReceipt> => {
      if (!onEditReceipt) {
        throw new Error("message send context edit is not configured");
      }
      const editedReceipt = await onEditReceipt(receipt, rendered);
      liveState = {
        ...liveState,
        receipt: editedReceipt,
        lastRendered: rendered,
      };
      ctx.preview = liveState;
      return editedReceipt;
    },
    delete: async (receipt) => {
      if (!onDeleteReceipt) {
        throw new Error("message send context delete is not configured");
      }
      await onDeleteReceipt(receipt);
    },
    commit: async (receipt) => {
      await onCommitReceipt?.(receipt);
    },
    fail: async (error) => {
      try {
        await onSendFailure?.(error);
      } catch (cleanupError: unknown) {
        log.warn(
          `message send failure cleanup failed; preserving original send error: ${formatErrorMessage(cleanupError)}`,
        );
      }
    },
  };

  try {
    const result = await run(ctx);
    return result;
  } catch (error: unknown) {
    // Cleanup failures are logged inside ctx.fail so callers still observe the original send error.
    await ctx.fail(error);
    throw error;
  }
}

export async function sendDurableMessageBatch(
  params: DurableMessageSendContextParams,
): Promise<DurableMessageBatchSendResult> {
  return await withDurableMessageSendContext(params, async (ctx) => {
    const rendered = await ctx.render();
    const result = await ctx.send(rendered);
    if (result.status === "sent" || result.status === "suppressed") {
      await ctx.commit(result.receipt);
    } else {
      await ctx.fail(result.error);
    }
    return result;
  });
}
