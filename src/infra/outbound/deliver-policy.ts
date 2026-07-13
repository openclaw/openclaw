import type { ReplyPayload } from "../../auto-reply/types.js";
import type { ChannelId } from "../../channels/plugins/channel-id.types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { OutboundDeliveryResult, OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
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

  const allowed: Array<{ index: number; payload: ReplyPayload }> = [];
  const rerouted: Array<{
    index: number;
    payload: ReplyPayload;
    channel: Exclude<ChannelId, "none">;
    to: string;
    accountId?: string;
    threadId?: string | number;
  }> = [];
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
      rerouted.push({
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
    allowed.push({ index, payload: decision.payload });
  }
  if (!changed) {
    return null;
  }

  const results: OutboundDeliveryResult[] = [];
  if (allowed.length > 0) {
    results.push(
      ...(await params.deliverAllowed({
        ...delivery,
        payloads: allowed.map((entry) => entry.payload),
        onPayloadDeliveryOutcome: (outcome) => {
          const original = allowed[outcome.index];
          delivery.onPayloadDeliveryOutcome?.(
            remapOutcome(outcome, original?.index ?? outcome.index),
          );
        },
      })),
    );
  }
  for (const reroute of rerouted) {
    const { accountId: _accountId, threadId: _threadId, ...baseDelivery } = delivery;
    void _accountId;
    void _threadId;
    results.push(
      ...(await params.deliverRerouted({
        ...baseDelivery,
        channel: reroute.channel,
        to: reroute.to,
        ...(reroute.accountId ? { accountId: reroute.accountId } : {}),
        ...(reroute.threadId !== undefined ? { threadId: reroute.threadId } : {}),
        payloads: [reroute.payload],
        deliveryPolicyDepth: policyDepth + 1,
        onPayloadDeliveryOutcome: (outcome) => {
          delivery.onPayloadDeliveryOutcome?.(remapOutcome(outcome, reroute.index));
        },
      })),
    );
  }
  return results;
}
