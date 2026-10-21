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
  const { isRoutableChannel, routeReply } = await import("./route-reply.js");
  assertCurrent();
  if (!isRoutableChannel(route.channel) || !route.to) {
    throw new Error(
      "Session event has no original external delivery route; inspect the session result or choose a delivery destination",
    );
  }
  const { channel, to, accountId, threadId } = route;
  return (params) => routeReply({ ...params, channel, to, accountId, threadId, mirror: false });
}
