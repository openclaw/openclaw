import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { DeliveryQueueWorkerOperations } from "../delivery-queue.worker-contract.js";
import { ackDeliveryInDatabase } from "./delivery-queue-ack.kernel.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "./delivery-queue-namespaces.js";

export function executeDeliveryQueueAck(
  input: DeliveryQueueWorkerOperations["deliveryQueue.ack"]["input"],
  writeOptions: { database: OpenClawStateDatabase; env: NodeJS.ProcessEnv },
): string[] {
  const { id, stateDir, options } = input;
  return runOpenClawStateWriteTransaction(
    (writer) => ackDeliveryInDatabase(writer, id, stateDir, options),
    writeOptions,
    { operationLabel: `mutate owned ${OUTBOUND_DELIVERY_QUEUE_NAME} delivery platform send` },
  );
}
