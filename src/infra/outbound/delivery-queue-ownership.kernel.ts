import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { getDeliveryQueueEntriesOwnersInDatabase } from "../delivery-queue-sqlite.kernel.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-namespaces.js";

const OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS = [
  { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, namespace: "prepared", retired: false },
  { queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME, namespace: "preparing", retired: true },
  { queueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, namespace: "migration", retired: true },
  {
    queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    namespace: "legacy-preparing",
    retired: true,
  },
  { queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, namespace: "legacy", retired: true },
] as const;

export function findDeliveryIntentOwnersInDatabase(
  database: OpenClawStateDatabase,
  params: { ids: readonly string[] },
) {
  const owners = getDeliveryQueueEntriesOwnersInDatabase(
    database,
    OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS.map(({ queueName }) => queueName),
    params.ids,
  );
  return params.ids.map((id) => {
    const namespaces = owners.get(id);
    for (const descriptor of OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS) {
      const owner = namespaces?.get(descriptor.queueName);
      if (owner) {
        return { ...descriptor, ...owner };
      }
    }
    return null;
  });
}
