import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import * as store from "./push-web-store.database.worker.js";
import { WebPushSubscriptionBindingError } from "./push-web-store.records.js";

type Input<Handler extends (input: never) => unknown> = Omit<Parameters<Handler>[0], "database">;

export const webPushOperations = {
  "webPush.findBoundWebPushSubscriptionByEndpoint": (
    input: Input<typeof store.findBoundWebPushSubscriptionByEndpointInDatabase>,
    { open },
  ) => store.findBoundWebPushSubscriptionByEndpointInDatabase({ ...input, database: open() }),
  "webPush.setWebPushSubscriptionPreferences": (
    input: Input<typeof store.setWebPushSubscriptionPreferencesInDatabase>,
    { open },
  ) => store.setWebPushSubscriptionPreferencesInDatabase({ ...input, database: open() }),
  "webPush.listWebPushSubscriptions": (_input: undefined, { open }) =>
    store.listWebPushSubscriptionsInDatabase(open()),
  "webPush.hasBoundWebPushSubscriptions": (_input: undefined, { open }) =>
    store.hasBoundWebPushSubscriptionsInDatabase(open()),
  "webPush.listBoundWebPushSubscriptions": (_input: undefined, { open }) =>
    store.listBoundWebPushSubscriptionsInDatabase(open()),
  "webPush.prepareWebPushApprovalDeliveries": (
    input: Input<typeof store.prepareWebPushApprovalDeliveriesInDatabase>,
    { open },
  ) => store.prepareWebPushApprovalDeliveriesInDatabase({ ...input, database: open() }),
  "webPush.listWebPushApprovalDeliveryTargets": (
    input: Input<typeof store.listWebPushApprovalDeliveryTargetsInDatabase>,
    { open },
  ) => store.listWebPushApprovalDeliveryTargetsInDatabase({ ...input, database: open() }),
  "webPush.deleteWebPushApprovalDeliveryTargets": (
    input: Input<typeof store.deleteWebPushApprovalDeliveryTargetsInDatabase>,
    { open },
  ) => store.deleteWebPushApprovalDeliveryTargetsInDatabase({ ...input, database: open() }),
  "webPush.listTerminalWebPushApprovalDeliveryIds": (
    input: Input<typeof store.listTerminalWebPushApprovalDeliveryIdsInDatabase>,
    { open },
  ) => store.listTerminalWebPushApprovalDeliveryIdsInDatabase({ ...input, database: open() }),
  "webPush.upsertWebPushSubscription": (
    input: Input<typeof store.upsertWebPushSubscriptionInDatabase>,
    { open },
  ) => {
    const database = open();
    try {
      return { subscription: store.upsertWebPushSubscriptionInDatabase({ ...input, database }) };
    } catch (error) {
      if (error instanceof WebPushSubscriptionBindingError) {
        return { bindingError: error.message };
      }
      throw error;
    }
  },
  "webPush.deleteBoundWebPushSubscription": (
    input: Input<typeof store.deleteBoundWebPushSubscriptionInDatabase>,
    { open },
  ) => store.deleteBoundWebPushSubscriptionInDatabase({ ...input, database: open() }),
  "webPush.deleteWebPushSubscriptionIfCurrent": (
    input: Input<typeof store.deleteWebPushSubscriptionIfCurrentInDatabase>,
    { open },
  ) => store.deleteWebPushSubscriptionIfCurrentInDatabase({ ...input, database: open() }),
  "webPush.readPersistedVapidKeyPair": (_input: undefined, { stateOptions }) =>
    store.readPersistedVapidKeyPairInDatabase(stateOptions()),
  "webPush.insertVapidKeyPairIfAbsent": (
    input: Input<typeof store.insertVapidKeyPairIfAbsentInDatabase>,
    { open },
  ) => store.insertVapidKeyPairIfAbsentInDatabase({ ...input, database: open() }),
} satisfies WorkerOperationHandlers;
