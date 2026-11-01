import type { DeliveryContext } from "../../utils/delivery-context.types.js";

type RouteReplyParams = Parameters<typeof import("./route-reply.js").routeReply>[0];
type SessionEventDeliveryParams = Pick<
  RouteReplyParams,
  | "cfg"
  | "agentId"
  | "sessionKey"
  | "payload"
  | "replyKind"
  | "abortSignal"
  | "beforeDeliver"
  | "assertCurrent"
>;

export async function prepareSessionEventDelivery(
  route: DeliveryContext,
  assertCurrent: () => void,
): Promise<
  (params: SessionEventDeliveryParams) => ReturnType<typeof import("./route-reply.js").routeReply>
> {
  const { isRoutableChannel, routeReply, routePreparedReply } = await import("./route-reply.js");
  assertCurrent();
  if (!isRoutableChannel(route.channel) || !route.to) {
    throw new Error(
      "Session event has no original external delivery route; inspect the session result or choose a delivery destination",
    );
  }
  const { channel, to, accountId, threadId } = route;
  return async (params) => {
    const { payload, ...delivery } = params;
    const destination = { channel, to, accountId, threadId, mirror: false };
    if (params.replyKind !== "final") {
      return routeReply({ ...params, ...destination });
    }
    // Dispatch already applied final lane policy and normalized this payload.
    // Preserve admitted reasoning without enabling raw tool or block reasoning.
    const { createStructuredOutboundPayloadPlan } =
      await import("../../infra/outbound/payloads.js");
    const [plan] = createStructuredOutboundPayloadPlan([payload]);
    if (!plan) {
      return { ok: true, delivered: false, suppressed: true };
    }
    return routePreparedReply({ ...delivery, ...destination, plan });
  };
}
