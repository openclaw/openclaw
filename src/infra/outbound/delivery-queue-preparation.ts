// Fences stable outbound policy preparation across Gateway processes without
// persisting payload content or modifying-hook context.
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { executeDeliveryQueueOperation } from "../delivery-queue-worker-store.js";
import type { StableDeliveryPreparation } from "./delivery-queue-storage.types.js";

const STABLE_PREPARATION_LEASE_MS = 5 * 60_000;
const STABLE_PREPARATION_LEASE_RENEW_MS = 30_000;

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

export async function withStableDeliveryPreparation<T>(
  params: {
    id: string;
    stateDir?: string;
    run: (owner: StableDeliveryPreparationOwner) => Promise<T>;
  },
  context?: DeliveryQueueStateContext,
): Promise<{ status: "claimed"; value: T } | { status: "existing" }> {
  const captured = context ?? captureDeliveryQueueStateContext(params.stateDir);
  const claim = await executeDeliveryQueueOperation(captured, params.stateDir, {
    type: "deliveryQueue.claimPreparation",
    input: { id: params.id },
  });
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
    const write = pendingWrite.then(async () => {
      if (leaseLost) {
        throw new StableDeliveryPreparationLostError(params.id);
      }
      if (checkpointFailure) {
        throw checkpointFailure.error;
      }
      const next = update(entry);
      if (
        !(await executeDeliveryQueueOperation(captured, params.stateDir, {
          type: "deliveryQueue.replacePreparation",
          input: { expectedEntry: entry, replacementEntry: next },
        }))
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
      !(await executeDeliveryQueueOperation(captured, params.stateDir, {
        type: "deliveryQueue.completePreparation",
        input: { expectedEntry: entry },
      }))
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
        await executeDeliveryQueueOperation(captured, params.stateDir, {
          type: "deliveryQueue.replacePreparation",
          input: { expectedEntry: entry, replacementEntry: released },
        });
      } else {
        await executeDeliveryQueueOperation(captured, params.stateDir, {
          type: "deliveryQueue.failPreparation",
          input: { entry },
        });
      }
    }
    throw error;
  } finally {
    await stopRenewals();
  }
}
