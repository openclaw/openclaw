// Settles exact outbound custody before releasing its queue-owned media.
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { prepareDeliveryQueueTerminalEntry } from "../delivery-queue-sqlite.kernel.js";
import {
  ackDeliveryInDatabase,
  failPendingDeliveryInDatabase,
  retireUnsentDeliveryInDatabase,
  type AckDeliveryOptions,
  type FailPendingDeliveryResult,
} from "./delivery-queue-ack.kernel.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  cancelDeliveryQueueMediaRetention,
  OUTBOUND_DELIVERY_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

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
  const stateDir = context?.stateDir ?? requestedStateDir;
  const env = resolveDeliveryQueueStateEnv(stateDir, context);
  const database = openOpenClawStateDatabase({ env });
  const spoolPaths =
    options && "expectedPlatformSendAttemptId" in options
      ? runOpenClawStateWriteTransaction(
          (writer) => ackDeliveryInDatabase(writer, id, stateDir, options),
          { database, env },
          { operationLabel: `mutate owned ${OUTBOUND_DELIVERY_QUEUE_NAME} delivery platform send` },
        )
      : ackDeliveryInDatabase(database, id, stateDir, options);
  if (!options?.retainSpoolArtifacts) {
    await releaseSpoolArtifacts(spoolPaths, stateDir);
  }
}

/** Conditionally dead-letter a freshly re-read pending entry without a claimed state. */
export async function failPendingDelivery(
  params: Parameters<typeof failPendingDeliveryInDatabase>[1],
  requestedStateDir?: string,
  context?: DeliveryQueueStateContext,
): Promise<FailPendingDeliveryResult> {
  const stateDir = context?.stateDir ?? requestedStateDir;
  const terminal = { queueName: OUTBOUND_DELIVERY_QUEUE_NAME, id: params.id, entry: params.entry };
  const prepared =
    params.expectedPlatformSendAttemptId === undefined
      ? prepareDeliveryQueueTerminalEntry(terminal)
      : undefined;
  const env = resolveDeliveryQueueStateEnv(stateDir, context);
  const database = openOpenClawStateDatabase({ env });
  const result =
    params.expectedPlatformSendAttemptId !== undefined
      ? runOpenClawStateWriteTransaction(
          (writer) => failPendingDeliveryInDatabase(writer, params, prepared),
          { database, env },
          { operationLabel: `mutate owned ${OUTBOUND_DELIVERY_QUEUE_NAME} delivery platform send` },
        )
      : failPendingDeliveryInDatabase(database, params, prepared);
  if (result.status === "failed" && params.retainSpoolArtifacts !== true) {
    await releaseSpoolArtifacts(
      collectEntrySpoolPaths(
        acceptedPreparedOutboundEntries(params.entry.preparedBatch).map((entry) => entry.payload),
        stateDir,
      ),
      stateDir,
    );
  }
  return result;
}
