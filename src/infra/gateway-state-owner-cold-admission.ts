import { setTimeout as delay } from "node:timers/promises";
import { StateDatabaseAdmissionPendingError } from "./gateway-state-owner-errors.js";
import { resolveIdentityPathViaExistingAncestorSync } from "./path-existence.js";
import { normalizeSqliteNonNegativeInteger } from "./sqlite-busy-timeout.js";

export type ColdAdmissionOptions = {
  databasePath: string;
  busyTimeoutMs: number;
  canRetry?: () => boolean;
};

export function createColdAdmissionBudget(params: ColdAdmissionOptions) {
  const budget = normalizeSqliteNonNegativeInteger(params.busyTimeoutMs, "busyTimeoutMs");
  const deadline = performance.now() + budget;
  const canonical = resolveIdentityPathViaExistingAncestorSync(params.databasePath);
  const remainingBusyTimeoutMs = () => Math.max(0, Math.ceil(deadline - performance.now()));
  const retryDelay = (error: unknown) => {
    if (
      !(error instanceof StateDatabaseAdmissionPendingError) ||
      resolveIdentityPathViaExistingAncestorSync(error.databasePath) !== canonical ||
      params.canRetry?.() === false
    ) {
      throw error;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw error;
    }
    return Math.min(10, remaining);
  };
  return { remainingBusyTimeoutMs, retryDelay };
}

/** Host-side admission supplies its own authority check and has not dispatched domain work. */
export async function withStateDatabaseColdAdmissionAsync<T>(
  params: ColdAdmissionOptions & { signal: AbortSignal },
  admit: () => Promise<T>,
): Promise<T> {
  const { retryDelay } = createColdAdmissionBudget(params);
  for (;;) {
    params.signal.throwIfAborted();
    try {
      return await admit();
    } catch (error) {
      await delay(retryDelay(error), undefined, { signal: params.signal });
    }
  }
}
