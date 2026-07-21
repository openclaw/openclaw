import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ChannelId } from "../../channels/plugins/channel-id.types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { DeliverOutboundPayloadsParams } from "./deliver-contract.js";
import {
  isOutboundDeliveryError,
  OutboundDeliveryError,
  suppressedPayloadOutcome,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import {
  MAX_OUTBOUND_DELIVERY_POLICY_REROUTES,
  runOutboundDeliveryPolicyHook,
  stripDestinationScopedReplyPayload,
  type OutboundDeliveryPolicyDecision,
  type OutboundDeliveryPolicySource,
} from "./delivery-policy-hook.js";

export type { OutboundDeliveryPolicyParams } from "./deliver-contract.js";

/** Internal policy controls accepted by the outbound delivery boundary. */
function sourceFromDeliveryParams(
  params: DeliverOutboundPayloadsParams,
): OutboundDeliveryPolicySource | undefined {
  return (
    params.deliveryPolicy?.source ??
    (params.session
      ? {
          ...(params.session.requesterAccountId
            ? { accountId: params.session.requesterAccountId }
            : {}),
          ...(params.session.requesterSenderId
            ? { senderId: params.session.requesterSenderId }
            : {}),
          ...(params.session.key ? { sessionKey: params.session.key } : {}),
        }
      : undefined)
  );
}

function stripDestinationScopedDeliveryParams(delivery: DeliverOutboundPayloadsParams) {
  const {
    accountId: _accountId,
    threadId: _threadId,
    replyToId: _replyToId,
    replyToMode: _replyToMode,
    renderedBatchPlan: _renderedBatchPlan,
    ...portableDelivery
  } = delivery;
  void _accountId;
  void _threadId;
  void _replyToId;
  void _replyToMode;
  void _renderedBatchPlan;
  return portableDelivery;
}

/** Resolve policy for one payload using the delivery's source and destination facts. */
async function resolveOutboundDeliveryPolicyDecision(
  delivery: DeliverOutboundPayloadsParams,
  payload: ReplyPayload,
): Promise<OutboundDeliveryPolicyDecision> {
  const source = sourceFromDeliveryParams(delivery);
  return await runOutboundDeliveryPolicyHook({
    payload,
    kind: delivery.deliveryPolicy?.action
      ? "message_action"
      : (delivery.replyPayloadSendingHook?.kind ?? "final"),
    ...(delivery.deliveryPolicy?.action ? { action: delivery.deliveryPolicy.action } : {}),
    ...(source ? { source } : {}),
    destination: {
      channel: delivery.channel,
      to: delivery.to,
      ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
      ...(delivery.threadId !== undefined && delivery.threadId !== null
        ? { threadId: delivery.threadId }
        : {}),
      path: delivery.deliveryPolicy?.path ?? "durable_delivery",
    },
    sessionKey: delivery.mirror?.sessionKey ?? delivery.session?.key,
    runId: delivery.deliveryPolicy?.runId ?? delivery.replyPayloadSendingHook?.runId,
  });
}

type FinalOutboundDeliveryPolicyResult =
  | { status: "continue"; payload: ReplyPayload }
  | {
      status: "terminal";
      results: OutboundDeliveryResult[];
      outcomes: OutboundPayloadDeliveryOutcome[];
    };

/** Recheck policy after legacy payload-mutating hooks and before platform I/O. */
export async function applyFinalOutboundDeliveryPolicy(params: {
  delivery: DeliverOutboundPayloadsParams;
  payload: ReplyPayload;
  deliverRerouted: (delivery: DeliverOutboundPayloadsParams) => Promise<OutboundDeliveryResult[]>;
}): Promise<FinalOutboundDeliveryPolicyResult> {
  const decision = await resolveOutboundDeliveryPolicyDecision(params.delivery, params.payload);
  if (decision.decision === "allow") {
    return { status: "continue", payload: decision.payload };
  }
  if (decision.decision === "cancel") {
    return {
      status: "terminal",
      results: [],
      outcomes: [
        suppressedPayloadOutcome({
          index: 0,
          reason: decision.suppressionReason,
          ...(decision.reason ? { hookEffect: { cancelReason: decision.reason } } : {}),
        }),
      ],
    };
  }

  const policyDepth = params.delivery.deliveryPolicyDepth ?? 0;
  if (policyDepth >= MAX_OUTBOUND_DELIVERY_POLICY_REROUTES) {
    throw new Error("Outbound delivery policy reroute depth exceeded.");
  }
  if (params.delivery.deliveryPolicy?.path === "message_action") {
    return {
      status: "terminal",
      results: [],
      outcomes: [
        suppressedPayloadOutcome({
          index: 0,
          reason: "cancelled_by_outbound_delivery_policy",
          hookEffect: {
            cancelReason: decision.reason ?? "post_finalization_reroute_suppressed",
          },
        }),
      ],
    };
  }
  const payload = stripDestinationScopedReplyPayload(decision.payload);
  const outcomes: OutboundPayloadDeliveryOutcome[] = [];
  const rerouteBase = stripDestinationScopedDeliveryParams(params.delivery);
  const results = await params.deliverRerouted({
    ...rerouteBase,
    channel: decision.destination.channel as Exclude<ChannelId, "none">,
    to: decision.destination.to,
    ...(decision.destination.accountId ? { accountId: decision.destination.accountId } : {}),
    ...(decision.destination.threadId !== undefined
      ? { threadId: decision.destination.threadId }
      : {}),
    payloads: [payload],
    replyPayloadSendingHook: undefined,
    skipQueue: true,
    skipInitialOutboundDeliveryPolicy: false,
    deliveryPolicyDepth: policyDepth + 1,
    onPayloadDeliveryOutcome: (outcome) => outcomes.push(outcome),
  });
  if (outcomes.length === 0) {
    outcomes.push(
      results.length > 0
        ? { index: 0, status: "sent", results }
        : suppressedPayloadOutcome({ index: 0, reason: "adapter_returned_no_identity" }),
    );
  }
  return { status: "terminal", results, outcomes };
}

function remapOutcome(
  outcome: OutboundPayloadDeliveryOutcome,
  index: number,
): OutboundPayloadDeliveryOutcome {
  return { ...outcome, index };
}

type PlannedDelivery =
  | { kind: "allowed"; index: number; payload: ReplyPayload }
  | {
      kind: "rerouted";
      index: number;
      payload: ReplyPayload;
      channel: Exclude<ChannelId, "none">;
      to: string;
      accountId?: string;
      threadId?: string | number;
    };

function wrapPolicyDeliveryError(params: {
  error: unknown;
  results: readonly OutboundDeliveryResult[];
  completedOutcomes: readonly OutboundPayloadDeliveryOutcome[];
  currentOutcomes: readonly OutboundPayloadDeliveryOutcome[];
  remapErrorOutcome: (outcome: OutboundPayloadDeliveryOutcome) => OutboundPayloadDeliveryOutcome;
}): OutboundDeliveryError {
  if (isOutboundDeliveryError(params.error)) {
    return new OutboundDeliveryError(params.error.message, {
      cause: params.error.cause ?? params.error,
      results: [...params.results, ...params.error.results],
      payloadOutcomes: [
        ...params.completedOutcomes,
        ...(params.error.payloadOutcomes.length > 0
          ? params.error.payloadOutcomes.map(params.remapErrorOutcome)
          : params.currentOutcomes),
      ],
      stage: params.error.stage,
    });
  }
  return new OutboundDeliveryError(
    params.error instanceof Error ? params.error.message : String(params.error),
    {
      cause: params.error,
      results: params.results,
      payloadOutcomes: [...params.completedOutcomes, ...params.currentOutcomes],
    },
  );
}

/** Apply policy to a normalized durable-delivery batch before platform I/O. */
export async function applyOutboundDeliveryPolicy(params: {
  delivery: DeliverOutboundPayloadsParams;
  deliverAllowed: (delivery: DeliverOutboundPayloadsParams) => Promise<OutboundDeliveryResult[]>;
  deliverRerouted: (delivery: DeliverOutboundPayloadsParams) => Promise<OutboundDeliveryResult[]>;
  recordSuppression: (
    outcome: Extract<OutboundPayloadDeliveryOutcome, { status: "suppressed" }> & {
      reason: "cancelled_by_outbound_delivery_policy" | "outbound_delivery_policy_failed";
    },
  ) => void;
}): Promise<OutboundDeliveryResult[] | null> {
  const delivery = params.delivery;
  const hookRunner = getGlobalHookRunner();
  if (
    delivery.skipInitialOutboundDeliveryPolicy ||
    !hookRunner?.hasHooks("outbound_delivery_policy")
  ) {
    return null;
  }
  const policyDepth = delivery.deliveryPolicyDepth ?? 0;
  if (policyDepth > MAX_OUTBOUND_DELIVERY_POLICY_REROUTES) {
    throw new Error("Outbound delivery policy reroute depth exceeded.");
  }

  const plan: PlannedDelivery[] = [];
  const suppressedOutcomes: Array<
    Extract<OutboundPayloadDeliveryOutcome, { status: "suppressed" }>
  > = [];
  let changed = false;

  for (const [index, payload] of delivery.payloads.entries()) {
    const decision = await resolveOutboundDeliveryPolicyDecision(delivery, payload);
    if (decision.decision === "cancel") {
      changed = true;
      const outcome = {
        index,
        status: "suppressed" as const,
        reason: decision.suppressionReason,
        ...(decision.reason ? { hookEffect: { cancelReason: decision.reason } } : {}),
      };
      suppressedOutcomes.push(outcome);
      params.recordSuppression(outcome);
      continue;
    }
    if (decision.decision === "reroute") {
      changed = true;
      plan.push({
        kind: "rerouted",
        index,
        payload: stripDestinationScopedReplyPayload(decision.payload),
        channel: decision.destination.channel as Exclude<ChannelId, "none">,
        to: decision.destination.to,
        ...(decision.destination.accountId ? { accountId: decision.destination.accountId } : {}),
        ...(decision.destination.threadId !== undefined
          ? { threadId: decision.destination.threadId }
          : {}),
      });
      continue;
    }
    changed ||= decision.payload !== payload;
    plan.push({ kind: "allowed", index, payload: decision.payload });
  }
  if (!changed) {
    return null;
  }

  const results: OutboundDeliveryResult[] = [];
  const completedOutcomes: OutboundPayloadDeliveryOutcome[] = [...suppressedOutcomes];
  for (let cursor = 0; cursor < plan.length;) {
    const entry = plan[cursor];
    if (!entry) {
      break;
    }
    const currentOutcomes: OutboundPayloadDeliveryOutcome[] = [];
    let remapErrorOutcome = (outcome: OutboundPayloadDeliveryOutcome) => outcome;
    try {
      if (entry.kind === "allowed") {
        const allowed: Array<Extract<PlannedDelivery, { kind: "allowed" }>> = [];
        while (plan[cursor]?.kind === "allowed") {
          allowed.push(plan[cursor] as Extract<PlannedDelivery, { kind: "allowed" }>);
          cursor += 1;
        }
        remapErrorOutcome = (outcome) => {
          const original = allowed[outcome.index];
          return remapOutcome(outcome, original?.index ?? outcome.index);
        };
        // Recovery intentionally retains its queue identity on every sub-send.
        // skipQueue prevents child acknowledgement; the recovery owner records
        // aggregate evidence and finalizes the row only after this plan settles.
        const { renderedBatchPlan: _renderedBatchPlan, ...allowedDelivery } = delivery;
        void _renderedBatchPlan;
        results.push(
          ...(await params.deliverAllowed({
            ...allowedDelivery,
            payloads: allowed.map((allowedEntry) => allowedEntry.payload),
            onPayloadDeliveryOutcome: (outcome) => {
              const remapped = remapErrorOutcome(outcome);
              currentOutcomes.push(remapped);
              delivery.onPayloadDeliveryOutcome?.(remapped);
            },
          })),
        );
      } else {
        cursor += 1;
        remapErrorOutcome = (outcome) => remapOutcome(outcome, entry.index);
        const baseDelivery = stripDestinationScopedDeliveryParams(delivery);
        results.push(
          ...(await params.deliverRerouted({
            ...baseDelivery,
            channel: entry.channel,
            to: entry.to,
            ...(entry.accountId ? { accountId: entry.accountId } : {}),
            ...(entry.threadId !== undefined ? { threadId: entry.threadId } : {}),
            payloads: [entry.payload],
            deliveryPolicyDepth: policyDepth + 1,
            onPayloadDeliveryOutcome: (outcome) => {
              const remapped = remapErrorOutcome(outcome);
              currentOutcomes.push(remapped);
              delivery.onPayloadDeliveryOutcome?.(remapped);
            },
          })),
        );
      }
      completedOutcomes.push(...currentOutcomes);
    } catch (error) {
      throw wrapPolicyDeliveryError({
        error,
        results,
        completedOutcomes,
        currentOutcomes,
        remapErrorOutcome,
      });
    }
  }
  return results;
}
