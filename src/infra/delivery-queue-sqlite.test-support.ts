import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { UpsertDeliveryQueueEntryParams } from "./delivery-queue-sqlite-bound.js";
import { upsertDeliveryQueueEntryInDatabase } from "./delivery-queue-sqlite.kernel.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
} from "./delivery-queue-state-context.js";

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
