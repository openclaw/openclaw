// Fences stable outbound policy preparation across Gateway processes without
// persisting payload content or modifying-hook context.
import { randomUUID } from "node:crypto";
import {
  completePendingDeliveryQueueEntry,
  replacePendingDeliveryQueueEntry,
  upsertDeliveryQueueEntryOnceAcrossNamespaces,
} from "../delivery-queue-sqlite-namespace.js";
import {
  captureDeliveryQueueStateContext,
  loadDeliveryQueueEntry,
  type DeliveryQueueStateContext,
  terminalizePendingDeliveryQueueEntry,
  type DeliveryQueueEntryState,
} from "../delivery-queue-sqlite.js";
import {
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
} from "./delivery-queue-media-staging.js";

const STABLE_PREPARATION_LEASE_MS = 5 * 60_000;
const STABLE_PREPARATION_LEASE_RENEW_MS = 30_000;

export type StableDeliveryPreparation = DeliveryQueueEntryState & {
  preparationState: "claimed" | "modifiers_started" | "prepared";
  preparationOwnerId?: string;
  preparationLeaseExpiresAt?: number;
};

export type StableDeliveryPreparationOwner = {
  current: () => Promise<StableDeliveryPreparation>;
  beforeFirstModifier: () => Promise<void>;
  markPrepared: () => Promise<void>;
  markPublished: () => void;
};

export class StableDeliveryPreparationLostError extends Error {
  constructor(id: string) {
    super(`Stable outbound preparation ownership was lost: ${id}`);
    this.name = "StableDeliveryPreparationLostError";
  }
}

const STABLE_PREPARATION_CONFLICT_QUEUES = [
  OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
] as const;

function createStablePreparation(
  id: string,
  ownerId: string,
  now = Date.now(),
): StableDeliveryPreparation {
  return {
    id,
    enqueuedAt: now,
    retryCount: 0,
    attemptCount: 0,
    retainOnFailure: true,
    preparationState: "claimed",
    preparationOwnerId: ownerId,
    preparationLeaseExpiresAt: now + STABLE_PREPARATION_LEASE_MS,
  };
}

function failStablePreparation(
  entry: StableDeliveryPreparation,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): void {
  terminalizePendingDeliveryQueueEntry(
    {
      queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
      id: entry.id,
      entry,
      stateDir,
    },
    context,
  );
}

function claimStablePreparation(
  id: string,
  stateDir?: string,
  context?: DeliveryQueueStateContext,
): { status: "claimed"; entry: StableDeliveryPreparation } | { status: "existing" } {
  const ownerId = randomUUID();
  const proposed = createStablePreparation(id, ownerId);
  if (
    upsertDeliveryQueueEntryOnceAcrossNamespaces(
      {
        queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
        conflictQueueNames: STABLE_PREPARATION_CONFLICT_QUEUES,
        entry: proposed,
        stateDir,
      },
      context,
    )
  ) {
    return { status: "claimed", entry: proposed };
  }

  const current = loadDeliveryQueueEntry(
    OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
    id,
    stateDir,
    "pending",
    context,
  ) as StableDeliveryPreparation | null;
  if (!current) {
    return { status: "existing" };
  }
  if ((current.preparationLeaseExpiresAt ?? 0) > Date.now()) {
    return { status: "existing" };
  }
  if (current.preparationState !== "claimed") {
    failStablePreparation(current, stateDir, context);
    return { status: "existing" };
  }
  const reclaimed = createStablePreparation(id, ownerId);
  return replacePendingDeliveryQueueEntry(
    {
      queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
      expectedEntry: current,
      replacementEntry: reclaimed,
      stateDir,
    },
    context,
  )
    ? { status: "claimed", entry: reclaimed }
    : { status: "existing" };
}

export async function withStableDeliveryPreparation<T>(
  params: {
    id: string;
    stateDir?: string;
    run: (owner: StableDeliveryPreparationOwner) => Promise<T>;
  },
  context?: DeliveryQueueStateContext,
): Promise<{ status: "claimed"; value: T } | { status: "existing" }> {
  const captured = context ?? captureDeliveryQueueStateContext(params.stateDir);
  const claim = claimStablePreparation(params.id, params.stateDir, captured);
  if (claim.status === "existing") {
    return claim;
  }

  let entry = claim.entry;
  let leaseLost = false;
  let published = false;
  let pendingWrite = Promise.resolve();
  let checkpointFailure: { error: unknown } | undefined;
  const replaceEntry = (
    update: (current: StableDeliveryPreparation) => StableDeliveryPreparation,
  ): Promise<void> => {
    const write = pendingWrite.then(() => {
      if (leaseLost) {
        throw new StableDeliveryPreparationLostError(params.id);
      }
      if (checkpointFailure) {
        throw checkpointFailure.error;
      }
      const next = update(entry);
      if (
        !replacePendingDeliveryQueueEntry(
          {
            queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
            expectedEntry: entry,
            replacementEntry: next,
            stateDir: params.stateDir,
          },
          captured,
        )
      ) {
        leaseLost = true;
        throw new StableDeliveryPreparationLostError(params.id);
      }
      entry = next;
    });
    pendingWrite = write.catch((error: unknown) => {
      checkpointFailure ??= { error };
    });
    return write;
  };
  const leaseTimer = setInterval(() => {
    if (!leaseLost && !checkpointFailure) {
      void replaceEntry((current) => ({
        ...current,
        preparationLeaseExpiresAt: Date.now() + STABLE_PREPARATION_LEASE_MS,
      })).catch(() => {
        leaseLost = true;
      });
    }
  }, STABLE_PREPARATION_LEASE_RENEW_MS);
  leaseTimer.unref();
  const stopRenewals = async (): Promise<void> => {
    clearInterval(leaseTimer);
    await pendingWrite;
  };
  const owner: StableDeliveryPreparationOwner = {
    current: async () => {
      // Freeze the exact CAS snapshot handed to atomic queue publication.
      await stopRenewals();
      if (leaseLost) {
        throw new StableDeliveryPreparationLostError(params.id);
      }
      if (checkpointFailure) {
        throw checkpointFailure.error;
      }
      return entry;
    },
    beforeFirstModifier: () =>
      replaceEntry((current) => ({
        ...current,
        preparationState: "modifiers_started",
        preparationLeaseExpiresAt: Date.now() + STABLE_PREPARATION_LEASE_MS,
      })),
    markPrepared: () =>
      replaceEntry((current) => ({
        ...current,
        preparationState: "prepared",
        preparationLeaseExpiresAt: Date.now() + STABLE_PREPARATION_LEASE_MS,
      })),
    markPublished: () => {
      published = true;
    },
  };

  try {
    const value = await params.run(owner);
    await stopRenewals();
    if (!published && leaseLost) {
      throw new StableDeliveryPreparationLostError(params.id);
    }
    if (!published && checkpointFailure) {
      throw checkpointFailure.error;
    }
    if (
      !published &&
      !completePendingDeliveryQueueEntry(
        {
          queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
          expectedEntry: entry,
          stateDir: params.stateDir,
        },
        captured,
      )
    ) {
      throw new Error(`Stable outbound preparation could not be settled: ${params.id}`);
    }
    return { status: "claimed", value };
  } catch (error) {
    await stopRenewals();
    if (!published && !leaseLost) {
      if (entry.preparationState === "claimed") {
        const released: StableDeliveryPreparation = {
          ...entry,
          preparationOwnerId: undefined,
          preparationLeaseExpiresAt: 0,
        };
        replacePendingDeliveryQueueEntry(
          {
            queueName: OUTBOUND_DELIVERY_PREPARATION_QUEUE_NAME,
            expectedEntry: entry,
            replacementEntry: released,
            stateDir: params.stateDir,
          },
          captured,
        );
      } else {
        failStablePreparation(entry, params.stateDir, captured);
      }
    }
    throw error;
  } finally {
    await stopRenewals();
  }
}
