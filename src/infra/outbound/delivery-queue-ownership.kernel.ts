import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import {
  deliveryQueueEntriesQuery,
  inflateDeliveryQueueRow,
  loadDeliveryQueueEntryInDatabase,
  type DeliveryQueueReadMode,
} from "../delivery-queue-sqlite-bound.js";
import { getDeliveryQueueEntriesOwnersInDatabase } from "../delivery-queue-sqlite.kernel.js";
import type { DeliveryQueueEntryState } from "../delivery-queue-sqlite.types.js";
import { executeSqliteQuerySync } from "../kysely-sync.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
  OUTBOUND_EXECUTABLE_QUEUE_NAMES,
  SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-namespaces.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";

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

export function loadOutboundDeliveryInDatabase(
  database: OpenClawStateDatabase,
  id: string,
  mode: DeliveryQueueReadMode,
): QueuedDelivery | null {
  const queueName = resolveOutboundDeliveryQueueNameInDatabase(database, id);
  const entry = loadDeliveryQueueEntryInDatabase(database, queueName, id, mode);
  if (!entry) {
    return null;
  }
  return projectOutboundDelivery(queueName, entry);
}

export function projectOutboundDelivery(
  queueName: string,
  entry: DeliveryQueueEntryState,
): QueuedDelivery {
  // SAFETY: Only executable outbound namespaces store prepared delivery payloads.
  const delivery = entry as QueuedDelivery;
  if (
    (queueName === SESSION_GENERATION_OUTBOUND_DELIVERY_QUEUE_NAME) !==
    (delivery.sessionGeneration !== undefined)
  ) {
    throw new Error(`Outbound delivery generation does not match its format: ${entry.id}`);
  }
  return delivery;
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

/** One read snapshot orders all executable formats without pruning or mutating custody. */
export function readOutboundDeliveriesInDatabase(
  database: Pick<OpenClawStateDatabase, "db">,
  input: { id?: string; mode: "pending" | "unfinished" },
): QueuedDelivery[] {
  let query = deliveryQueueEntriesQuery(database, OUTBOUND_EXECUTABLE_QUEUE_NAMES, input.mode)
    .select("queue_name")
    .orderBy("enqueued_at", "asc")
    .orderBy("id", "asc");
  if (input.id !== undefined) {
    query = query.where("id", "=", input.id);
  }
  const seen = new Set<string>();
  return executeSqliteQuerySync(database.db, query).rows.flatMap((row) => {
    const entry = inflateDeliveryQueueRow(row);
    if (!entry) {
      return [];
    }
    if (seen.has(entry.id)) {
      throw new Error(`Ambiguous outbound delivery custody: ${entry.id}`);
    }
    seen.add(entry.id);
    return [projectOutboundDelivery(row.queue_name, entry)];
  });
}
