import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { DeliveryQueueWorkerOperations } from "../delivery-queue.worker-contract.js";
import { failPendingDeliveryInDatabase } from "./delivery-queue-ack.kernel.js";
import { collectEntrySpoolPaths } from "./delivery-queue-media-paths.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

export function executePendingDeliveryFailure(
  input: DeliveryQueueWorkerOperations["deliveryQueue.failPending"]["input"],
  writeOptions: { database: OpenClawStateDatabase; env: NodeJS.ProcessEnv },
): DeliveryQueueWorkerOperations["deliveryQueue.failPending"]["output"] {
  // SAFETY: The host captured the typed queue entry at its JSON persistence boundary.
  const entry = JSON.parse(input.entryJson) as QueuedDelivery;
  const params = { ...input, entry };
  const result =
    input.expectedPlatformSendAttemptId !== undefined
      ? runOpenClawStateWriteTransaction(
          (writer) => failPendingDeliveryInDatabase(writer, params, input.prepared),
          writeOptions,
          { operationLabel: `mutate owned ${OUTBOUND_DELIVERY_QUEUE_NAME} delivery platform send` },
        )
      : failPendingDeliveryInDatabase(writeOptions.database, params, input.prepared);
  // Derive cleanup only after native settlement, including guarded stale-payload no-ops.
  const spoolPaths =
    result.status === "failed" && input.retainSpoolArtifacts !== true
      ? collectEntrySpoolPaths(
          acceptedPreparedOutboundEntries(entry.preparedBatch).map((prepared) => prepared.payload),
          input.stateDir,
        )
      : [];
  return { result, spoolPaths };
}
