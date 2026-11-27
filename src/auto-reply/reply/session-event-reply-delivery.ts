import type { ReplyPayload } from "../../shared/reply-payload.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { SessionEventOptions } from "./session-event-contract.js";
import { prepareSessionEventDelivery } from "./session-event-delivery.js";
import { getSessionEventRuntimeConfig } from "./session-event-target.js";

type SessionEventDeliveryState = {
  delivered: boolean;
  deliveryAttempted: boolean;
  deliveryAmbiguous: boolean;
  deliveryError: string | undefined;
};

export function createSessionEventDeliveryState(): SessionEventDeliveryState {
  return {
    delivered: false,
    deliveryAttempted: false,
    deliveryAmbiguous: false,
    deliveryError: undefined,
  };
}

export async function deliverSessionEventReply(params: {
  route: DeliveryContext | undefined;
  payload: ReplyPayload;
  kind: "tool" | "block" | "final";
  deliveryDisabled: boolean;
  suppressErrorDelivery?: boolean;
  sourceDeliverySatisfied?: boolean;
  agentId: string;
  sessionKey: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  assertEffectCurrent: () => void;
  automation: SessionEventOptions["scheduledAutomation"];
  state: SessionEventDeliveryState;
}): Promise<void> {
  const {
    route,
    payload,
    kind,
    deliveryDisabled,
    suppressErrorDelivery,
    sourceDeliverySatisfied,
    agentId,
    sessionKey,
    signal,
    assertCurrent,
    assertEffectCurrent,
    automation,
    state,
  } = params;
  if (deliveryDisabled || (suppressErrorDelivery && payload.isError === true)) {
    return;
  }
  if (kind === "final" && sourceDeliverySatisfied) {
    return;
  }
  if (!route?.channel || route.channel === INTERNAL_MESSAGE_CHANNEL) {
    // The normal transcript remains the result for internal/WebChat turns.
    // This is not evidence of a transport send.
    return;
  }
  const deliverReply = await prepareSessionEventDelivery(route, assertCurrent);
  state.deliveryAttempted = true;
  const assertDeliveryCurrent = () => {
    assertEffectCurrent();
    automation?.assertDeliveryCurrent?.();
  };
  const result = await deliverReply({
    cfg: getSessionEventRuntimeConfig(),
    agentId,
    sessionKey,
    payload,
    replyKind: kind,
    abortSignal: signal,
    beforeDeliver: async () => {
      await automation?.beforeDeliver?.();
      assertDeliveryCurrent();
    },
    assertCurrent: assertDeliveryCurrent,
  });
  state.delivered ||= result.delivered;
  state.deliveryAmbiguous ||= result.ambiguous === true;
  if (!result.ok) {
    if (!automation) {
      throw new Error(result.error ?? "Session event delivery failed");
    }
    // Cron records transport failure separately from completed agent work.
    state.deliveryError = result.error ?? "Session event delivery failed";
  }
}
