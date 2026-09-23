// Coordinates queue-media filesystem staging with durable SQLite ownership.
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  deleteDeliveryQueueEntry,
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { executeDeliveryQueueOperation } from "../delivery-queue-worker-store.js";
import { generateSecureUuid } from "../secure-random.js";
import {
  createDeliveryQueueMediaRetentionInDatabase,
  type loadDeliveryQueueMediaRetentionSnapshotInDatabase,
} from "./delivery-queue-media-staging.kernel.js";
import { DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME } from "./delivery-queue-namespaces.js";

export * from "./delivery-queue-namespaces.js";

export function createDeliveryQueueMediaRetention(
  artifacts: readonly string[],
  entryKind: "outbound-media-stage" | "outbound-media-recovery-lease",
  stateDir?: string,
  database?: OpenClawStateDatabase,
  context?: DeliveryQueueStateContext,
): string {
  const prepared = { id: generateSecureUuid(), enqueuedAt: Date.now() };
  const preparedArtifacts = [...artifacts];
  return createDeliveryQueueMediaRetentionInDatabase(
    database ?? openOpenClawStateDatabase({ env: resolveDeliveryQueueStateEnv(stateDir, context) }),
    preparedArtifacts,
    entryKind,
    prepared,
  );
}

/** Release a stage or recovery lease after its owner settles. */
export function cancelDeliveryQueueMediaRetention(
  id: string | undefined,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): void {
  if (!id) {
    return;
  }
  deleteDeliveryQueueEntry(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, id, stateDir, context);
}

/** Captures staging expiry and all media custody on the same connection. */
export async function loadDeliveryQueueMediaRetentionSnapshot(
  params: { expireBeforeMs: number; stateDir?: string },
  context?: DeliveryQueueStateContext,
): Promise<ReturnType<typeof loadDeliveryQueueMediaRetentionSnapshotInDatabase>> {
  return executeDeliveryQueueOperation(context, params.stateDir, {
    type: "deliveryQueue.mediaRetentionSnapshot",
    input: { expireBeforeMs: params.expireBeforeMs },
  });
}
