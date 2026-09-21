import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import {
  countFailedDeliveryQueueEntriesInDatabase,
  pruneExpiredDeliveryQueueTombstonesInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import type { DeliveryQueueWorkerOperations } from "./delivery-queue.worker-contract.js";
import { executeDeliveryQueueAck } from "./outbound/delivery-queue-ack.worker.js";
import { executeDeliveryQueueEnqueue } from "./outbound/delivery-queue-enqueue.worker.js";
import { loadDeliveryQueueMediaRetentionSnapshotInDatabase } from "./outbound/delivery-queue-media-staging.kernel.js";
import { executePendingDeliveryFailure } from "./outbound/delivery-queue-pending-failure.worker.js";
import { executeDeliveryQueuePlatformLeaseCommand } from "./outbound/delivery-queue-platform-lease.worker.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

export function isDeliveryQueueCommand(command: {
  type: string;
}): command is { type: keyof DeliveryQueueWorkerOperations } {
  return (
    command.type === "deliveryQueue.claimPlatformSend" ||
    command.type === "deliveryQueue.renewPlatformSendLease" ||
    command.type === "deliveryQueue.ack" ||
    command.type === "deliveryQueue.enqueue" ||
    command.type === "deliveryQueue.failPending" ||
    command.type === "deliveryQueue.countFailed" ||
    command.type === "deliveryQueue.pruneTombstones" ||
    command.type === "deliveryQueue.mediaRetentionSnapshot"
  );
}

export function executeDeliveryQueueCommand(
  command: SqliteWorkerCommand<DeliveryQueueWorkerOperations>,
  options: { database: OpenClawStateDatabase; env: NodeJS.ProcessEnv },
): DeliveryQueueWorkerOperations[keyof DeliveryQueueWorkerOperations]["output"] {
  switch (command.type) {
    case "deliveryQueue.claimPlatformSend":
    case "deliveryQueue.renewPlatformSendLease":
      return executeDeliveryQueuePlatformLeaseCommand(command, options);
    case "deliveryQueue.ack":
      return executeDeliveryQueueAck(command.input, options);
    case "deliveryQueue.enqueue":
      return executeDeliveryQueueEnqueue(command.input, options);
    case "deliveryQueue.failPending":
      return executePendingDeliveryFailure(command.input, options);
    case "deliveryQueue.countFailed":
      return countFailedDeliveryQueueEntriesInDatabase(options.database);
    case "deliveryQueue.pruneTombstones":
      return pruneExpiredDeliveryQueueTombstonesInDatabase(options.database);
    case "deliveryQueue.mediaRetentionSnapshot":
      return loadDeliveryQueueMediaRetentionSnapshotInDatabase(options.database, command.input);
  }
}
