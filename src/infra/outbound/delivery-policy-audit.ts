import type { DeliverOutboundPayloadsParams } from "./deliver-contract.js";
import type { OutboundPayloadDeliveryOutcome } from "./deliver-types.js";
import { emitOutboundAuditTerminals } from "./outbound-audit.js";

type PolicySuppression = Extract<OutboundPayloadDeliveryOutcome, { status: "suppressed" }> & {
  reason: "cancelled_by_outbound_delivery_policy";
};

/** Record a policy cancellation for callers and trusted delivery audit listeners. */
export function recordOutboundPolicySuppression(params: {
  delivery: DeliverOutboundPayloadsParams;
  outcome: PolicySuppression;
  startedAt: number;
}): void {
  params.delivery.onPayloadDeliveryOutcome?.(params.outcome);
  if (params.delivery.deliveryQueueId !== undefined) {
    return;
  }
  emitOutboundAuditTerminals({
    context: params.delivery,
    terminals: [
      {
        payloadIndex: params.outcome.index,
        terminal: { outcome: "suppressed", reasonCode: params.outcome.reason },
      },
    ],
    startedAt: params.startedAt,
  });
}
