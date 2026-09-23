import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  transitionOwnedDeliveryQueueEntryInDatabase,
  type claimDeliveryQueueEntryPlatformSendInDatabase,
  promoteDeliveryQueueEntryPlatformSendInDatabase,
  dispatchDeliveryQueueEntryPlatformSendInDatabase,
} from "./delivery-queue-sqlite-claim.kernel.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.js";

type PlatformClaimParams = Parameters<typeof claimDeliveryQueueEntryPlatformSendInDatabase>[1] & {
  stateDir?: string;
};

export {
  createInitialDeliveryProducerClaim,
  PLATFORM_SEND_OWNER_LEASE_MS,
  type InitialDeliveryProducerClaim,
} from "./delivery-queue-sqlite-claim.kernel.js";

/** Runs an existing queue mutation only while its exact platform owner survives. */
export function transitionOwnedDeliveryQueueEntry(
  params: {
    queueName: string;
    id: string;
    stateDir?: string;
    database?: OpenClawStateDatabase;
    platformSendAttemptId: string | null;
  },
  // Unlike void, undefined rejects async callbacks before they can escape the transaction.
  transition: (entry: DeliveryQueueEntryState, database: OpenClawStateDatabase) => undefined,
  context?: DeliveryQueueStateContext,
): boolean {
  return runOpenClawStateWriteTransaction(
    (database) => transitionOwnedDeliveryQueueEntryInDatabase(database, params, transition),
    { database: params.database, env: resolveDeliveryQueueStateEnv(params.stateDir, context) },
    { operationLabel: `mutate owned ${params.queueName} delivery platform send` },
  );
}

/** Atomically fence the exact unexpired owner at the real provider boundary. */
export function promoteDeliveryQueueEntryPlatformSend(
  params: PlatformClaimParams & {
    claimId: string;
    route?: { replyToId?: string | null };
  },
  context?: DeliveryQueueStateContext,
): boolean {
  return runOpenClawStateWriteTransaction(
    (database) => promoteDeliveryQueueEntryPlatformSendInDatabase(database, params),
    { env: resolveDeliveryQueueStateEnv(params.stateDir, context) },
    { operationLabel: `promote ${params.queueName} delivery platform send` },
  );
}

/** Atomically authorize dispatch, promoting a producer claim into the active attempt. */
export function dispatchDeliveryQueueEntryPlatformSend(
  params: PlatformClaimParams & {
    claimId: string;
    route?: { replyToId?: string | null };
  },
  context?: DeliveryQueueStateContext,
): boolean {
  return runOpenClawStateWriteTransaction(
    (database) => dispatchDeliveryQueueEntryPlatformSendInDatabase(database, params),
    { env: resolveDeliveryQueueStateEnv(params.stateDir, context) },
    { operationLabel: `dispatch ${params.queueName} delivery platform send` },
  );
}
