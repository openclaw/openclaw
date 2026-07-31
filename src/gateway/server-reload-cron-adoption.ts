import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";

type GatewayCronConfigAdoption = {
  complete(): void;
  reject(error: unknown): Promise<unknown>;
};

const cronAdoptionTails = new WeakMap<GatewayCronServiceContract, Promise<void>>();

async function acquireCronConfigAdoption(cron: GatewayCronServiceContract): Promise<() => void> {
  const previous = cronAdoptionTails.get(cron) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.then(() => current);
  cronAdoptionTails.set(cron, tail);
  await previous;
  return () => {
    releaseCurrent();
    if (cronAdoptionTails.get(cron) === tail) {
      cronAdoptionTails.delete(cron);
    }
  };
}

/** Owns scheduler rollback until a candidate config reaches its commit edge. */
export async function beginGatewayCronConfigAdoption(params: {
  cron: GatewayCronServiceContract;
  enabled: boolean;
  nextConfig: OpenClawConfig;
  failureLabel: string;
  isCurrent: () => boolean;
}): Promise<GatewayCronConfigAdoption | null> {
  if (!params.enabled) {
    return null;
  }
  // Config candidates may overlap while superseding each other. Serialize the scheduler
  // adoption through commit/reject so an obsolete candidate cannot roll back a newer one.
  const releaseAdoption = await acquireCronConfigAdoption(params.cron);
  if (!params.isCurrent()) {
    releaseAdoption();
    return null;
  }
  let pending = true;
  const reject = async (error: unknown): Promise<unknown> => {
    if (!pending) {
      return error;
    }
    try {
      await params.cron.rejectConfigAdoption();
      return error;
    } catch (rollbackError) {
      return new AggregateError(
        [error, rollbackError],
        `${params.failureLabel} and cron config adoption rollback failed`,
      );
    } finally {
      pending = false;
      releaseAdoption();
    }
  };
  try {
    await params.cron.reloadForConfigAdoption(params.nextConfig);
  } catch (error) {
    throw await reject(error);
  }
  return {
    complete() {
      if (!pending) {
        return;
      }
      if (!params.isCurrent()) {
        throw new Error("gateway config candidate superseded before cron adoption commit");
      }
      // A throwing completion still owns rollback and the serialization tail; the caller's
      // catch path must invoke reject() before a newer candidate can adopt the scheduler.
      params.cron.completeConfigAdoption(params.nextConfig);
      pending = false;
      releaseAdoption();
    },
    reject,
  };
}
