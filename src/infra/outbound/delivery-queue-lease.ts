import { PLATFORM_SEND_OWNER_LEASE_MS } from "../delivery-queue-sqlite-claim.kernel.js";

const PLATFORM_SEND_OWNER_HEARTBEAT_MS = Math.floor(PLATFORM_SEND_OWNER_LEASE_MS / 3);

export type DeliveryProducerLease = {
  signal: AbortSignal;
  stop: () => Promise<void>;
};

class DeliveryProducerLeaseLostError extends Error {
  override name = "DeliveryProducerLeaseLostError";
}

function lostProducerLeaseError(id: string, cause?: unknown): Error {
  return new DeliveryProducerLeaseLostError(`Delivery platform claim was lost: ${id}`, { cause });
}

/** Maintains one already-acquired producer claim during fallible preparation and send. */
export async function startDeliveryProducerLease(params: {
  id: string;
  renew: () => Promise<number | undefined>;
}): Promise<DeliveryProducerLease> {
  try {
    const initialExpiry = await params.renew();
    if (initialExpiry === undefined) {
      throw lostProducerLeaseError(params.id);
    }
  } catch (error) {
    if (error instanceof DeliveryProducerLeaseLostError) {
      throw error;
    }
    throw lostProducerLeaseError(params.id, error);
  }

  const lost = new AbortController();
  let stopResult: Promise<void> | undefined;
  let pendingRenewal: Promise<void> | undefined;
  const abortLost = (cause?: unknown): void => {
    if (!stopResult && !lost.signal.aborted) {
      lost.abort(lostProducerLeaseError(params.id, cause));
    }
  };
  const renew = async (): Promise<void> => {
    if (stopResult || lost.signal.aborted) {
      return;
    }
    try {
      const expiresAt = await params.renew();
      if (stopResult) {
        return;
      }
      if (expiresAt === undefined) {
        abortLost();
        return;
      }
    } catch (error) {
      abortLost(error);
    }
  };

  const heartbeat = setInterval(() => {
    if (!pendingRenewal) {
      pendingRenewal = renew().finally(() => {
        pendingRenewal = undefined;
      });
    }
  }, PLATFORM_SEND_OWNER_HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    signal: lost.signal,
    stop: () => {
      if (!stopResult) {
        stopResult = pendingRenewal ?? Promise.resolve();
        clearInterval(heartbeat);
      }
      return stopResult;
    },
  };
}
