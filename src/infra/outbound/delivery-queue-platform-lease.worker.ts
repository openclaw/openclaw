import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  claimDeliveryQueueEntryPlatformSendInDatabase,
  renewDeliveryQueueEntryPlatformSendLeaseInDatabase,
} from "../delivery-queue-sqlite-claim.kernel.js";
import type { DeliveryQueueWorkerOperations } from "../delivery-queue.worker-contract.js";
import type { SqliteWorkerCommand } from "../sqlite-worker-contract.js";
import { resolveOutboundDeliveryQueueNameInDatabase } from "./delivery-queue-ownership.kernel.js";

type LeaseOperations = Pick<
  DeliveryQueueWorkerOperations,
  "deliveryQueue.claimPlatformSend" | "deliveryQueue.renewPlatformSendLease"
>;

export function executeDeliveryQueuePlatformLeaseCommand(
  command: SqliteWorkerCommand<LeaseOperations>,
  options: { database: OpenClawStateDatabase; env: NodeJS.ProcessEnv },
): LeaseOperations[keyof LeaseOperations]["output"] {
  return runOpenClawStateWriteTransaction(
    (database) =>
      command.type === "deliveryQueue.claimPlatformSend"
        ? claimDeliveryQueueEntryPlatformSendInDatabase(
            database,
            {
              ...command.input,
              queueName: resolveOutboundDeliveryQueueNameInDatabase(database, command.input.id),
            },
            command.input.claimId,
          )
        : renewDeliveryQueueEntryPlatformSendLeaseInDatabase(database, {
            ...command.input,
            queueName: resolveOutboundDeliveryQueueNameInDatabase(database, command.input.id),
          }),
    options,
    {
      operationLabel: command.type,
    },
  );
}
