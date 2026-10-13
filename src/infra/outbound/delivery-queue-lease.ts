import { scheduleAbsoluteDeadline } from "../../utils/absolute-deadline.js";
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
  let confirmedExpiresAt: number;
  try {
    const initialExpiry = await params.renew();
    if (initialExpiry === undefined || initialExpiry <= Date.now()) {
      throw lostProducerLeaseError(params.id);
    }
    confirmedExpiresAt = initialExpiry;
  } catch (error) {
    if (error instanceof DeliveryProducerLeaseLostError) {
      throw error;
    }
    throw lostProducerLeaseError(params.id, error);
  }

  const lost = new AbortController();
  let stopResult: Promise<void> | undefined;
  let pendingRenewal: Promise<void> | undefined;
  let cancelExpiry: (() => void) | undefined;
  const abortLost = (cause?: unknown): void => {
    if (!stopResult && !lost.signal.aborted) {
      lost.abort(lostProducerLeaseError(params.id, cause));
    }
  };
  const scheduleExpiry = (): void => {
    cancelExpiry?.();
    cancelExpiry = scheduleAbsoluteDeadline(confirmedExpiresAt, () => abortLost(), undefined, {
      unref: true,
    });
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
      confirmedExpiresAt = expiresAt;
      scheduleExpiry();
    } catch (error) {
      // A transient storage failure does not revoke the last confirmed lease.
      // Its expiry timer remains authoritative while later heartbeats retry.
      if (!stopResult && Date.now() >= confirmedExpiresAt) {
        abortLost(error);
      }
    }
  };

  scheduleExpiry();
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
        cancelExpiry?.();
      }
      return stopResult;
    },
  };
}
