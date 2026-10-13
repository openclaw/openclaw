import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  loadDeliveryQueueEntryInDatabase,
  type DeliveryQueueReadMode,
  type UpsertDeliveryQueueEntryParams,
} from "./delivery-queue-sqlite-bound.js";
import {
  getDeliveryQueueEntryOwnersInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "./delivery-queue-state-context.js";

/** Inspect exact seeded rows, including corruption and terminal test fixtures. */
export function loadDeliveryQueueEntry(
  queueName: string,
  id: string,
  stateDir?: string,
  mode: DeliveryQueueReadMode = "pending",
  context?: DeliveryQueueStateContext,
) {
  return loadDeliveryQueueEntryInDatabase(
    openOpenClawStateDatabase({ env: resolveDeliveryQueueStateEnv(stateDir, context) }),
    queueName,
    id,
    mode,
  );
}

/** Inspect seeded/native custody without waiting behind the writer a test holds. */
export function getDeliveryQueueEntryStatus(queueName: string, id: string, stateDir?: string) {
  return getDeliveryQueueEntryOwnersInDatabase(
    openOpenClawStateDatabase({ env: resolveDeliveryQueueStateEnv(stateDir) }),
    [queueName],
    id,
  ).get(queueName)?.status;
}

/** Seed exact queue rows, including legacy and terminal states outside live admission. */
export function seedDeliveryQueueEntry(
  params: UpsertDeliveryQueueEntryParams,
  context?: DeliveryQueueStateContext,
): boolean {
  return upsertDeliveryQueueEntryInDatabase(
    params,
    openOpenClawStateDatabase({ env: resolveDeliveryQueueStateEnv(params.stateDir, context) }),
  );
}
