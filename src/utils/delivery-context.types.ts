import type { ChannelRouteRef, ChannelRouteTargetInput } from "../plugin-sdk/channel-route.js";

/** Queue intent attached to delivery contexts that should be persisted before send. */
export type DeliveryIntentRef = {
  id: string;
  kind: "outbound_queue";
  queuePolicy?: "required" | "best_effort";
};

/** Compact channel target carried across sessions, tasks, cron, and gateway calls. */
export type DeliveryContext = Pick<
  ChannelRouteTargetInput,
  "accountId" | "channel" | "threadId" | "to"
> & {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
  deliveryIntent?: DeliveryIntentRef;
};

/** Session-entry shape accepted by delivery-context recovery helpers. */
export type DeliveryContextSessionSource = {
  route?: ChannelRouteRef;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  deliveryContext?: DeliveryContext;
};
