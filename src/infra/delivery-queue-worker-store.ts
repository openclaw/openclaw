import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "./delivery-queue-state-context.js";
import type { DeliveryQueueWorkerOperations } from "./delivery-queue.worker-contract.js";

export async function executeDeliveryQueueOperation<
  Key extends keyof DeliveryQueueWorkerOperations,
>(
  context: DeliveryQueueStateContext | undefined,
  stateDir: string | undefined,
  command: { type: Key; input: DeliveryQueueWorkerOperations[Key]["input"] },
): Promise<DeliveryQueueWorkerOperations[Key]["output"]> {
  const captured = context ?? captureDeliveryQueueStateContext(stateDir);
  return await runOpenClawStateWorkerOperation(captured.workerContext, (scope) =>
    scope.execute(command),
  );
}
