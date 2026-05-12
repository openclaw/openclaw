import type { ChannelRouteTargetInput } from "../plugin-sdk/channel-route.js";

export type DeliveryIntentRef = {
  id: string;
  kind: "outbound_queue";
  queuePolicy?: "required" | "best_effort";
};

export type DeliveryContext = Pick<
  ChannelRouteTargetInput,
  "accountId" | "channel" | "chatType" | "threadId" | "to"
> & {
  channel?: string;
  to?: string;
  accountId?: string;
  chatType?: ChannelRouteTargetInput["chatType"];
  threadId?: string | number;
  deliveryIntent?: DeliveryIntentRef;
};

export type DeliveryContextSessionSource = {
  channel?: string;
  deliveryContext?: DeliveryContext;
};
