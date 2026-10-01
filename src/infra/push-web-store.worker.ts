import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as store from "./push-web-store.kernel.js";
import { WebPushSubscriptionBindingError } from "./push-web-store.records.js";
import type { WebPushWorkerOperations } from "./push-web-store.worker-contract.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

type WebPushCommand = Exclude<
  SqliteWorkerCommand<WebPushWorkerOperations>,
  { type: "webPush.readPersistedVapidKeyPair" }
>;

export function isWebPushCommand(command: {
  type: string;
  input: unknown;
}): command is WebPushCommand {
  return (
    command.type === "webPush.findBoundWebPushSubscriptionByEndpoint" ||
    command.type === "webPush.setWebPushSubscriptionPreferences" ||
    command.type === "webPush.listWebPushSubscriptions" ||
    command.type === "webPush.hasBoundWebPushSubscriptions" ||
    command.type === "webPush.listBoundWebPushSubscriptions" ||
    command.type === "webPush.prepareWebPushApprovalDeliveries" ||
    command.type === "webPush.listWebPushApprovalDeliveryTargets" ||
    command.type === "webPush.deleteWebPushApprovalDeliveryTargets" ||
    command.type === "webPush.listTerminalWebPushApprovalDeliveryIds" ||
    command.type === "webPush.upsertWebPushSubscription" ||
    command.type === "webPush.deleteBoundWebPushSubscription" ||
    command.type === "webPush.deleteWebPushSubscriptionIfCurrent" ||
    command.type === "webPush.insertVapidKeyPairIfAbsent"
  );
}

export function executeWebPushCommand(
  command: WebPushCommand,
  database: OpenClawStateDatabase,
): WebPushWorkerOperations[keyof WebPushWorkerOperations]["output"] {
  switch (command.type) {
    case "webPush.findBoundWebPushSubscriptionByEndpoint":
      return store.findBoundWebPushSubscriptionByEndpointInDatabase({ ...command.input, database });
    case "webPush.setWebPushSubscriptionPreferences":
      return store.setWebPushSubscriptionPreferencesInDatabase({ ...command.input, database });
    case "webPush.listWebPushSubscriptions":
      return store.listWebPushSubscriptionsInDatabase(database);
    case "webPush.hasBoundWebPushSubscriptions":
      return store.hasBoundWebPushSubscriptionsInDatabase(database);
    case "webPush.listBoundWebPushSubscriptions":
      return store.listBoundWebPushSubscriptionsInDatabase(database);
    case "webPush.prepareWebPushApprovalDeliveries":
      return store.prepareWebPushApprovalDeliveriesInDatabase({ ...command.input, database });
    case "webPush.listWebPushApprovalDeliveryTargets":
      return store.listWebPushApprovalDeliveryTargetsInDatabase({ ...command.input, database });
    case "webPush.deleteWebPushApprovalDeliveryTargets":
      return store.deleteWebPushApprovalDeliveryTargetsInDatabase({ ...command.input, database });
    case "webPush.listTerminalWebPushApprovalDeliveryIds":
      return store.listTerminalWebPushApprovalDeliveryIdsInDatabase({ ...command.input, database });
    case "webPush.upsertWebPushSubscription":
      try {
        return {
          subscription: store.upsertWebPushSubscriptionInDatabase({ ...command.input, database }),
        };
      } catch (error) {
        if (error instanceof WebPushSubscriptionBindingError) {
          return { bindingError: error.message };
        }
        throw error;
      }
    case "webPush.deleteBoundWebPushSubscription":
      return store.deleteBoundWebPushSubscriptionInDatabase({ ...command.input, database });
    case "webPush.deleteWebPushSubscriptionIfCurrent":
      return store.deleteWebPushSubscriptionIfCurrentInDatabase({ ...command.input, database });
    case "webPush.insertVapidKeyPairIfAbsent":
      return store.insertVapidKeyPairIfAbsentInDatabase({ ...command.input, database });
  }
}
