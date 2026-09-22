import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { loadDeliveryQueueEntryInDatabase } from "./delivery-queue-sqlite-bound.js";
import { upsertDeliveryQueueEntryInDatabase } from "./delivery-queue-sqlite.kernel.js";
import {
  hasLiveDeliveryQueueClaim,
  type DeliveryQueueEntryState,
} from "./delivery-queue-sqlite.types.js";
import { generateSecureUuid } from "./secure-random.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

type PlatformClaimParams = {
  queueName: string;
  id: string;
  requiresProducerClaim?: boolean;
  reconciledPlatformSendAttemptId?: string;
  reconciledPlatformSendStartedAt?: number;
};

export const PLATFORM_SEND_OWNER_LEASE_MS = 60_000;

/** Creates the owner published atomically with an immediate live delivery. */
export function createInitialDeliveryProducerClaim(now = Date.now()) {
  return {
    requiresProducerClaim: true,
    availableAt: now + PLATFORM_SEND_OWNER_LEASE_MS,
    producerClaimId: generateSecureUuid(),
    recoveryState: "producer_claimed",
  } as const;
}

export type InitialDeliveryProducerClaim = ReturnType<typeof createInitialDeliveryProducerClaim>;

/** Runs an existing queue mutation only while its exact platform owner survives. */
export function transitionOwnedDeliveryQueueEntryInDatabase(
  database: OpenClawStateDatabase,
  params: {
    queueName: string;
    id: string;
    platformSendAttemptId: string | null;
  },
  // Unlike void, undefined rejects async callbacks before they can escape the transaction.
  transition: (entry: DeliveryQueueEntryState, database: OpenClawStateDatabase) => undefined,
): boolean {
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const entry = loadDeliveryQueueEntryInDatabase(
        database,
        params.queueName,
        params.id,
        "pending",
      );
      if (!entry) {
        return false;
      }
      if (
        params.platformSendAttemptId === null
          ? entry.platformSendAttemptId !== undefined || entry.producerClaimId !== undefined
          : entry.platformSendAttemptId !== params.platformSendAttemptId &&
            entry.producerClaimId !== params.platformSendAttemptId
      ) {
        return false;
      }
      transition(entry, database);
      return true;
    },
    {
      databaseLabel: database.path,
      operationLabel: `mutate owned ${params.queueName} delivery platform send`,
    },
  );
}

function transitionDeliveryQueueEntryPlatformSendInDatabase(
  database: OpenClawStateDatabase,
  params: PlatformClaimParams,
  operation: "claim" | "promote" | "dispatch",
  transition: (entry: DeliveryQueueEntryState, now: number) => DeliveryQueueEntryState | undefined,
): boolean {
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const current = loadDeliveryQueueEntryInDatabase(
        database,
        params.queueName,
        params.id,
        "pending",
      );
      if (!current) {
        return false;
      }
      if (
        current.platformSendStartedAt !== undefined &&
        (operation === "promote" ||
          (operation === "claim" &&
            (current.platformSendStartedAt !== params.reconciledPlatformSendStartedAt ||
              current.platformSendAttemptId !== params.reconciledPlatformSendAttemptId ||
              typeof current.platformSendAttemptId !== "string")))
      ) {
        return false;
      }
      const updated = transition(current, Date.now());
      return updated
        ? upsertDeliveryQueueEntryInDatabase(
            {
              queueName: params.queueName,
              entry: updated,
              updatePendingOnly: true,
            },
            database,
          )
        : false;
    },
    {
      databaseLabel: database.path,
      operationLabel: `${operation} ${params.queueName} delivery platform send`,
    },
  );
}

/** Claim a recoverable producer lease before any provider invocation. */
export function claimDeliveryQueueEntryPlatformSendInDatabase(
  database: OpenClawStateDatabase,
  params: PlatformClaimParams,
  claimId = generateSecureUuid(),
): string | undefined {
  return transitionDeliveryQueueEntryPlatformSendInDatabase(
    database,
    params,
    "claim",
    (entry, now) => {
      const reconciledNotSent =
        entry.recoveryState === "send_attempt_started" &&
        typeof params.reconciledPlatformSendStartedAt === "number" &&
        entry.platformSendStartedAt === params.reconciledPlatformSendStartedAt &&
        typeof params.reconciledPlatformSendAttemptId === "string" &&
        entry.platformSendAttemptId === params.reconciledPlatformSendAttemptId;
      if (
        entry.recoveryState &&
        !reconciledNotSent &&
        (entry.recoveryState !== "producer_claimed" ||
          typeof entry.availableAt !== "number" ||
          entry.availableAt > now)
      ) {
        return undefined;
      }
      return {
        ...entry,
        ...(params.requiresProducerClaim === true ? { requiresProducerClaim: true } : {}),
        availableAt: now + PLATFORM_SEND_OWNER_LEASE_MS,
        producerClaimId: claimId,
        platformSendAttemptId: undefined,
        platformSendStartedAt: undefined,
        recoveryState: "producer_claimed",
      };
    },
  )
    ? claimId
    : undefined;
}

/** Renew only the exact unexpired producer that already owns the row. */
export function renewDeliveryQueueEntryPlatformSendLeaseInDatabase(
  database: OpenClawStateDatabase,
  params: Pick<PlatformClaimParams, "queueName" | "id"> & {
    claimId: string;
  },
): number | undefined {
  return runSqliteImmediateTransactionSync(
    database.db,
    () => {
      const entry = loadDeliveryQueueEntryInDatabase(
        database,
        params.queueName,
        params.id,
        "pending",
      );
      const now = Date.now();
      if (
        !entry ||
        entry.requiresProducerClaim !== true ||
        !hasLiveDeliveryQueueClaim(entry, params.claimId, now)
      ) {
        return undefined;
      }
      const expiresAt = now + PLATFORM_SEND_OWNER_LEASE_MS;
      return upsertDeliveryQueueEntryInDatabase(
        {
          queueName: params.queueName,
          entry: { ...entry, availableAt: expiresAt },
          updatePendingOnly: true,
        },
        database,
      )
        ? expiresAt
        : undefined;
    },
    {
      databaseLabel: database.path,
      operationLabel: `renew ${params.queueName} delivery platform send`,
    },
  );
}

/** Atomically fence the exact unexpired owner at the real provider boundary. */
export function promoteDeliveryQueueEntryPlatformSendInDatabase(
  database: OpenClawStateDatabase,
  params: PlatformClaimParams & {
    claimId: string;
    route?: { replyToId?: string | null };
  },
): boolean {
  return transitionDeliveryQueueEntryPlatformSendInDatabase(
    database,
    params,
    "promote",
    (entry, now) =>
      entry.recoveryState === "producer_claimed" &&
      hasLiveDeliveryQueueClaim(entry, params.claimId, now)
        ? {
            ...entry,
            // Only an explicitly leased owner keeps its cross-process fence;
            // legacy recovery must remain immediately eligible after a crash.
            availableAt:
              entry.requiresProducerClaim === true ? now + PLATFORM_SEND_OWNER_LEASE_MS : undefined,
            producerClaimId: undefined,
            platformSendAttemptId: params.claimId,
            platformSendStartedAt: now,
            ...(params.route && "replyToId" in params.route
              ? { effectiveReplyToId: params.route.replyToId ?? null }
              : {}),
            recoveryState: "send_attempt_started",
          }
        : undefined,
  );
}

export function dispatchDeliveryQueueEntryPlatformSendInDatabase(
  database: OpenClawStateDatabase,
  params: PlatformClaimParams & {
    claimId: string;
    route?: { replyToId?: string | null };
  },
): boolean {
  return transitionDeliveryQueueEntryPlatformSendInDatabase(
    database,
    params,
    "dispatch",
    (entry, now) => {
      if (!hasLiveDeliveryQueueClaim(entry, params.claimId, now)) {
        return undefined;
      }
      return {
        ...entry,
        // Exact reconciliation can skip pre-send promotion, so publish attempt identity
        // atomically; later batch dispatches retain stronger unknown-after-send evidence.
        availableAt:
          entry.requiresProducerClaim === true
            ? entry.recoveryState === "producer_claimed"
              ? now + PLATFORM_SEND_OWNER_LEASE_MS
              : entry.availableAt
            : undefined,
        producerClaimId: undefined,
        platformSendAttemptId: params.claimId,
        platformSendStartedAt: now,
        ...(params.route && "replyToId" in params.route
          ? { effectiveReplyToId: params.route.replyToId ?? null }
          : {}),
        recoveryState:
          entry.recoveryState === "unknown_after_send"
            ? "unknown_after_send"
            : "send_attempt_started",
      };
    },
  );
}
