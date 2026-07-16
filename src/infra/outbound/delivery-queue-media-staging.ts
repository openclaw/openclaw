// Coordinates queue-media filesystem staging with durable SQLite ownership.
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  deleteDeliveryQueueEntry,
  expireStagingAndLoadDeliveryQueueEntries,
  upsertDeliveryQueueEntry,
  type DeliveryQueueEntryState,
} from "../delivery-queue-sqlite.js";
import { generateSecureUuid } from "../secure-random.js";

export const OUTBOUND_DELIVERY_QUEUE_NAME = "outbound";
export const DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME = "outbound-media-staging";

type MediaStageEntry = DeliveryQueueEntryState & { artifacts: string[] };
type OutboundMediaEntry = DeliveryQueueEntryState & { payloads: ReplyPayload[] };

/** Register planned artifacts before any file becomes visible to the sweeper. */
export function createDeliveryQueueMediaStage(
  artifacts: readonly string[],
  stateDir?: string,
): string {
  const id = generateSecureUuid();
  const entry: MediaStageEntry = {
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
    artifacts: [...artifacts],
  };
  const inserted = upsertDeliveryQueueEntry({
    queueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
    entry,
    metadata: { entryKind: "outbound-media-stage" },
    stateDir,
    insertOnly: true,
  });
  if (!inserted) {
    throw new Error(`Delivery queue media stage already exists: ${id}`);
  }
  return id;
}

/** Cancel a stage that will never publish an outbound queue row. */
export function cancelDeliveryQueueMediaStage(id: string | undefined, stateDir?: string): void {
  if (!id) {
    return;
  }
  deleteDeliveryQueueEntry(DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME, id, stateDir);
}

/**
 * Atomically expire abandoned stages and return every artifact still owned by
 * either a replayable outbound row or a producer that may still commit one.
 */
export function loadDeliveryQueueMediaRetentionSnapshot(params: {
  expireBeforeMs: number;
  stateDir?: string;
}): { payloads: ReplyPayload[][]; stagedArtifacts: string[] } {
  const snapshot = expireStagingAndLoadDeliveryQueueEntries({
    queueName: OUTBOUND_DELIVERY_QUEUE_NAME,
    stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
    expireBeforeMs: params.expireBeforeMs,
    stateDir: params.stateDir,
  });
  return {
    payloads: snapshot.entries.flatMap((entry) => {
      const payloads = (entry as OutboundMediaEntry).payloads;
      return Array.isArray(payloads) ? [payloads] : [];
    }),
    stagedArtifacts: snapshot.stagingEntries.flatMap((entry) => {
      const artifacts = (entry as MediaStageEntry).artifacts;
      return Array.isArray(artifacts)
        ? artifacts.filter((artifact): artifact is string => typeof artifact === "string")
        : [];
    }),
  };
}
