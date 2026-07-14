import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ChannelId } from "../../channels/plugins/channel-id.types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  isOutboundDeliveryError,
  OutboundDeliveryError,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import type { DeliverOutboundPayloadsParams } from "./deliver.js";
import {
  MAX_OUTBOUND_DELIVERY_POLICY_REROUTES,
  runOutboundDeliveryPolicyHook,
  type OutboundDeliveryPolicySource,
} from "./delivery-policy-hook.js";

/** Internal policy controls accepted by the outbound delivery boundary. */
export type OutboundDeliveryPolicyParams = {
  deliveryPolicy?: {
    path?: "durable_delivery" | "message_action";
    action?: string;
    source?: OutboundDeliveryPolicySource;
    runId?: string;
  };
  skipOutboundDeliveryPolicy?: boolean;
  deliveryPolicyDepth?: number;
};

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
  recordSuppression: (index: number, reason?: string) => void;
}): Promise<OutboundDeliveryResult[] | null> {
  const delivery = params.delivery;
  const hookRunner = getGlobalHookRunner();
  if (delivery.skipOutboundDeliveryPolicy || !hookRunner?.hasHooks("outbound_delivery_policy")) {
    return null;
  }
  const policyDepth = delivery.deliveryPolicyDepth ?? 0;
  if (policyDepth > MAX_OUTBOUND_DELIVERY_POLICY_REROUTES) {
    throw new Error("Outbound delivery policy reroute depth exceeded.");
  }

  const plan: PlannedDelivery[] = [];
  let changed = false;

  for (const [index, payload] of delivery.payloads.entries()) {
    const source = sourceFromDeliveryParams(delivery);
    const decision = await runOutboundDeliveryPolicyHook({
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
    if (decision.decision === "cancel") {
      changed = true;
      params.recordSuppression(index, decision.reason);
      continue;
    }
    if (decision.decision === "reroute") {
      changed = true;
      plan.push({
        kind: "rerouted",
        index,
        payload: decision.payload,
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
  const completedOutcomes: OutboundPayloadDeliveryOutcome[] = [];
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
        results.push(
          ...(await params.deliverAllowed({
            ...delivery,
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
        const { accountId: _accountId, threadId: _threadId, ...baseDelivery } = delivery;
        void _accountId;
        void _threadId;
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
