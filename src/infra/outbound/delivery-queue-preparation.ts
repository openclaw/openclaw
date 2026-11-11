// Checkpoints stable outbound policy preparation without persisting payload content.
import {
  captureDeliveryQueueStateContext,
  type DeliveryQueueStateContext,
} from "../delivery-queue-sqlite.js";
import { executeDeliveryQueueOperation } from "../delivery-queue-worker-store.js";
import type { StableDeliveryPreparation } from "./delivery-queue-storage.types.js";

const STABLE_PREPARATION_LEASE_MS = 5 * 60_000;

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
  const replaceEntry = async (
    preparationState: StableDeliveryPreparation["preparationState"],
  ): Promise<void> => {
    const next = {
      ...entry,
      preparationState,
      preparationLeaseExpiresAt: Date.now() + STABLE_PREPARATION_LEASE_MS,
    };
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
  };
  const owner: StableDeliveryPreparationOwner = {
    current: async () => entry,
    beforeFirstModifier: () => replaceEntry("modifiers_started"),
    markPrepared: () => replaceEntry("prepared"),
    markPublished: () => {
      published = true;
    },
  };

  try {
    const value = await params.run(owner);
    if (!published) {
      if (
        !(await executeDeliveryQueueOperation(captured, params.stateDir, {
          type: "deliveryQueue.completePreparation",
          input: { expectedEntry: entry },
        }))
      ) {
        throw new Error(`Stable outbound preparation could not be settled: ${params.id}`);
      }
    }
    return { status: "claimed", value };
  } catch (error) {
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
  }
}
