import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  transitionOwnedDeliveryQueueEntryInDatabase,
  claimDeliveryQueueEntryPlatformSendInDatabase,
  renewDeliveryQueueEntryPlatformSendLeaseInDatabase,
  promoteDeliveryQueueEntryPlatformSendInDatabase,
  dispatchDeliveryQueueEntryPlatformSendInDatabase,
} from "./delivery-queue-sqlite-claim.kernel.js";
import {
  resolveDeliveryQueueStateEnv,
  type DeliveryQueueStateContext,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.js";
import { generateSecureUuid } from "./secure-random.js";

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

/** Claim a recoverable producer lease before any provider invocation. */
export function claimDeliveryQueueEntryPlatformSend(
  params: PlatformClaimParams,
  context?: DeliveryQueueStateContext,
): string | undefined {
  const claimId = generateSecureUuid();
  return runOpenClawStateWriteTransaction(
    (database) => claimDeliveryQueueEntryPlatformSendInDatabase(database, params, claimId),
    { env: resolveDeliveryQueueStateEnv(params.stateDir, context) },
    { operationLabel: `claim ${params.queueName} delivery platform send` },
  );
}

/** Renew only the exact unexpired producer that already owns the row. */
export function renewDeliveryQueueEntryPlatformSendLease(
  params: Pick<PlatformClaimParams, "queueName" | "id" | "stateDir"> & {
    claimId: string;
  },
  context?: DeliveryQueueStateContext,
): number | undefined {
  return runOpenClawStateWriteTransaction(
    (database) => renewDeliveryQueueEntryPlatformSendLeaseInDatabase(database, params),
    { env: resolveDeliveryQueueStateEnv(params.stateDir, context) },
    { operationLabel: `renew ${params.queueName} delivery platform send` },
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
