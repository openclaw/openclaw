// Coordinates queue-media filesystem staging with durable SQLite ownership.
import type { DeliveryQueueStateContext } from "../delivery-queue-sqlite.js";
import { executeDeliveryQueueOperation } from "../delivery-queue-worker-store.js";
import { generateSecureUuid } from "../secure-random.js";
import type { loadDeliveryQueueMediaRetentionSnapshotInDatabase } from "./delivery-queue-media-staging.kernel.js";

export * from "./delivery-queue-namespaces.js";

export async function createDeliveryQueueMediaRetention(
  artifacts: readonly string[],
  entryKind: "outbound-media-stage" | "outbound-media-recovery-lease",
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<string> {
  const prepared = { id: generateSecureUuid(), enqueuedAt: Date.now() };
  return executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.createMediaRetention",
    input: { artifacts: [...artifacts], entryKind, prepared },
  });
}

/** Release a stage or recovery lease after its owner settles. */
export async function cancelDeliveryQueueMediaRetention(
  id: string | undefined,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  if (!id) {
    return;
  }
  await executeDeliveryQueueOperation(context, stateDir, {
    type: "deliveryQueue.cancelMediaRetention",
    input: { id },
  });
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
