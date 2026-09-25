import type * as store from "./push-web-store.kernel.js";

export type WebPushWorkerOperations = {
  "webPush.findBoundWebPushSubscriptionByEndpoint": {
    input: Omit<
      Parameters<typeof store.findBoundWebPushSubscriptionByEndpointInDatabase>[0],
      "database"
    >;
    output: ReturnType<typeof store.findBoundWebPushSubscriptionByEndpointInDatabase>;
  };
  "webPush.setWebPushSubscriptionPreferences": {
    input: Omit<
      Parameters<typeof store.setWebPushSubscriptionPreferencesInDatabase>[0],
      "database" | "assertCurrent"
    >;
    output: ReturnType<typeof store.setWebPushSubscriptionPreferencesInDatabase>;
  };
  "webPush.listWebPushSubscriptions": {
    input: undefined;
    output: ReturnType<typeof store.listWebPushSubscriptionsInDatabase>;
  };
  "webPush.hasBoundWebPushSubscriptions": {
    input: undefined;
    output: ReturnType<typeof store.hasBoundWebPushSubscriptionsInDatabase>;
  };
  "webPush.listBoundWebPushSubscriptions": {
    input: undefined;
    output: ReturnType<typeof store.listBoundWebPushSubscriptionsInDatabase>;
  };
  "webPush.prepareWebPushApprovalDeliveries": {
    input: Omit<Parameters<typeof store.prepareWebPushApprovalDeliveriesInDatabase>[0], "database">;
    output: ReturnType<typeof store.prepareWebPushApprovalDeliveriesInDatabase>;
  };
  "webPush.listWebPushApprovalDeliveryTargets": {
    input: Omit<
      Parameters<typeof store.listWebPushApprovalDeliveryTargetsInDatabase>[0],
      "database"
    >;
    output: ReturnType<typeof store.listWebPushApprovalDeliveryTargetsInDatabase>;
  };
  "webPush.deleteWebPushApprovalDeliveryTargets": {
    input: Omit<
      Parameters<typeof store.deleteWebPushApprovalDeliveryTargetsInDatabase>[0],
      "database"
    >;
    output: ReturnType<typeof store.deleteWebPushApprovalDeliveryTargetsInDatabase>;
  };
  "webPush.listTerminalWebPushApprovalDeliveryIds": {
    input: Omit<
      Parameters<typeof store.listTerminalWebPushApprovalDeliveryIdsInDatabase>[0],
      "database"
    >;
    output: ReturnType<typeof store.listTerminalWebPushApprovalDeliveryIdsInDatabase>;
  };
  "webPush.upsertWebPushSubscription": {
    input: Omit<
      Parameters<typeof store.upsertWebPushSubscriptionInDatabase>[0],
      "database" | "assertCurrent"
    >;
    output:
      | {
          subscription: ReturnType<typeof store.upsertWebPushSubscriptionInDatabase>;
          bindingError?: never;
        }
      | { bindingError: string; subscription?: never };
  };
  "webPush.deleteBoundWebPushSubscription": {
    input: Omit<
      Parameters<typeof store.deleteBoundWebPushSubscriptionInDatabase>[0],
      "database" | "assertCurrent"
    >;
    output: ReturnType<typeof store.deleteBoundWebPushSubscriptionInDatabase>;
  };
  "webPush.deleteWebPushSubscriptionIfCurrent": {
    input: Omit<
      Parameters<typeof store.deleteWebPushSubscriptionIfCurrentInDatabase>[0],
      "database"
    >;
    output: ReturnType<typeof store.deleteWebPushSubscriptionIfCurrentInDatabase>;
  };
  "webPush.readPersistedVapidKeyPair": {
    input: undefined;
    output: ReturnType<typeof store.readPersistedVapidKeyPairInDatabase>;
  };
  "webPush.insertVapidKeyPairIfAbsent": {
    input: Omit<Parameters<typeof store.insertVapidKeyPairIfAbsentInDatabase>[0], "database">;
    output: ReturnType<typeof store.insertVapidKeyPairIfAbsentInDatabase>;
  };
};
