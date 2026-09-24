// Settles exact outbound custody before releasing its queue-owned media.
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  captureDeliveryQueueStateContext,
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { prepareDeliveryQueueTerminalEntry } from "../delivery-queue-sqlite.kernel.js";
import { executeDeliveryQueueOperation } from "../delivery-queue-worker-store.js";
import {
  type failPendingDeliveryInDatabase,
  retireUnsentDeliveryInDatabase,
} from "./delivery-queue-ack.kernel.js";
import { releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  cancelDeliveryQueueMediaRetention,
  OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import type {
  AckDeliveryOptions,
  FailPendingDeliveryResult,
} from "./delivery-queue-settlement.types.js";

/** Retires an unsent live claim while its adapter preparation still owns resources. */
export function retireUnsentDelivery(
  params: Parameters<typeof retireUnsentDeliveryInDatabase>[1],
  context?: DeliveryQueueStateContext,
  terminalOutcome?: "failed",
): (() => Promise<void>) | undefined {
  const stateDir = context?.stateDir ?? params.stateDir;
  const retired = runOpenClawStateWriteTransaction(
    (database) =>
      retireUnsentDeliveryInDatabase(database, { ...params, stateDir }, terminalOutcome),
    { env: resolveDeliveryQueueStateEnv(stateDir, context) },
    { operationLabel: `mutate owned ${OUTBOUND_DELIVERY_QUEUE_NAME} delivery platform send` },
  );
  if (!retired) {
    return undefined;
  }
  return async () => {
    try {
      await releaseSpoolArtifacts(retired.spoolPaths, stateDir);
    } finally {
      cancelDeliveryQueueMediaRetention(retired.retention, stateDir, context);
    }
  };
}

/** Remove a successfully delivered entry, or retain its producer-owned receipt. */
export async function ackDelivery(
  id: string,
  requestedStateDir?: string,
  options?: AckDeliveryOptions,
  context?: DeliveryQueueStateContext,
): Promise<void> {
  const captured = context ?? captureDeliveryQueueStateContext(requestedStateDir);
  const stateDir = captured.stateDir;
  // Presence requests an exact-owner check even when the supplied value is undefined.
  const capturedOptions: AckDeliveryOptions | undefined = options
    ? {
        retainSpoolArtifacts: options.retainSpoolArtifacts,
        suppressCompletionReceipt: options.suppressCompletionReceipt,
        ...("expectedPlatformSendAttemptId" in options
          ? { expectedPlatformSendAttemptId: options.expectedPlatformSendAttemptId }
          : {}),
      }
    : undefined;
  const spoolPaths = await executeDeliveryQueueOperation(captured, stateDir, {
    type: "deliveryQueue.ack",
    input: { id, stateDir, options: capturedOptions },
  });
  if (!capturedOptions?.retainSpoolArtifacts) {
    await releaseSpoolArtifacts(spoolPaths, stateDir);
  }
}

/** Conditionally dead-letter a freshly re-read pending entry without a claimed state. */
export async function failPendingDelivery(
  params: Parameters<typeof failPendingDeliveryInDatabase>[1],
  requestedStateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<FailPendingDeliveryResult> {
  const terminal = { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, id: params.id, entry: params.entry };
  const prepared =
    params.expectedPlatformSendAttemptId === undefined
      ? prepareDeliveryQueueTerminalEntry(terminal)
      : undefined;
  const captured = context ?? captureDeliveryQueueStateContext(requestedStateDir);
  const stateDir = captured.stateDir;
  const { result, spoolPaths } = await executeDeliveryQueueOperation(captured, stateDir, {
    type: "deliveryQueue.failPending",
    input: {
      id: params.id,
      entryJson: prepared?.expectedJson ?? JSON.stringify(params.entry),
      expectedPlatformSendAttemptId: params.expectedPlatformSendAttemptId,
      retainSpoolArtifacts: params.retainSpoolArtifacts,
      stateDir,
      prepared: prepared ? structuredClone(prepared) : undefined,
    },
  });
  if (result.status === "failed") {
    await releaseSpoolArtifacts(spoolPaths, stateDir);
  }
  return result;
}
