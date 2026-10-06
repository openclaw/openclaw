import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { prepareDeliveryQueueTerminalEntry } from "../delivery-queue-sqlite.kernel.js";
import { failPendingDeliveryInDatabase } from "./delivery-queue-ack.kernel.js";
import { collectEntrySpoolPaths } from "./delivery-queue-media-paths.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-namespaces.js";
import type { FailPendingDeliveryResult } from "./delivery-queue-settlement.types.js";
import type { QueuedDelivery } from "./delivery-queue-types.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

export function executePendingDeliveryFailure(
  input: {
    id: string;
    entryJson: string;
    expectedPlatformSendAttemptId?: string | null;
    retainSpoolArtifacts?: boolean;
    stateDir: string;
    prepared?: ReturnType<typeof prepareDeliveryQueueTerminalEntry>;
  },
  writeOptions: { database: OpenClawStateDatabase; env: NodeJS.ProcessEnv },
): { result: FailPendingDeliveryResult; spoolPaths: string[] } {
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
