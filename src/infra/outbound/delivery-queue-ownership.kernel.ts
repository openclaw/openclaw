import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { getDeliveryQueueEntriesOwnersInDatabase } from "../delivery-queue-sqlite.kernel.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
  OUTBOUND_EXECUTABLE_QUEUE_NAMES,
  SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-namespaces.js";

const OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS = [
  { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, namespace: "prepared", retired: false },
  {
    queueName: SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME,
    namespace: "prepared",
    retired: false,
  },
  { queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME, namespace: "preparing", retired: true },
  { queueName: OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME, namespace: "migration", retired: true },
  {
    queueName: OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
    namespace: "legacy-preparing",
    retired: true,
  },
  { queueName: LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME, namespace: "legacy", retired: true },
] as const;

/** Exact IDs share one custody owner across the executable outbound formats. */
export function resolveOutboundDeliveryQueueNameInDatabase(
  database: OpenClawStateDatabase,
  id: string,
): string {
  const owners = getDeliveryQueueEntriesOwnersInDatabase(
    database,
    OUTBOUND_EXECUTABLE_QUEUE_NAMES,
    [id],
  ).get(id);
  if (owners && owners.size > 1) {
    throw new Error(`Ambiguous outbound delivery custody: ${id}`);
  }
  return owners?.keys().next().value ?? OUTBOUND_DELIVERY_QUEUE_NAME;
}

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
    if (OUTBOUND_EXECUTABLE_QUEUE_NAMES.every((queueName) => namespaces?.has(queueName))) {
      throw new Error(`Ambiguous outbound delivery custody: ${id}`);
    }
    for (const descriptor of OUTBOUND_DELIVERY_NAMESPACE_DESCRIPTORS) {
      const owner = namespaces?.get(descriptor.queueName);
      if (owner) {
        return { ...descriptor, ...owner };
      }
    }
    return null;
  });
}
