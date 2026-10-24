import { randomUUID } from "node:crypto";
import type { SessionAccessScope } from "../config/sessions/session-accessor.types.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { GatewayScheduledJob, GatewayScheduler } from "../infra/gateway-scheduler.js";

/** Owns startup custody discovery retries; execution remains with native turn admission. */
export function createQuestionRecovery(params: {
  scheduler: GatewayScheduler;
  discover: () => Promise<{
    scopes: readonly SessionAccessScope[];
    unavailable?: readonly unknown[];
  }>;
  pendingPreparation?: () => Promise<unknown> | undefined;
  recover: (scope: SessionAccessScope) => Promise<void>;
  assertCurrent: () => void;
  track: (run: () => Promise<void>) => Promise<void>;
  warn: (message: string) => void;
}) {
  const scheduler = params.scheduler.scope();
  const retryId = `durable-question-startup-recovery:${randomUUID()}`;
  const recovered = new Set<string>();
  let inFlight: Promise<void> | undefined;
  let initialWork: Promise<void> | undefined;
  let retryDelayMs = 1_000;
  let retry: GatewayScheduledJob | undefined;
  let preparationWork: Promise<void> | undefined;
  let passFailures: unknown[] = [];
  let preparationFailure: { error: unknown } | undefined;
  const warn = (message: string) => {
    try {
      params.warn(message);
    } catch {
      // Reporting failure cannot retire unresolved startup custody or hide siblings.
    }
  };
  const current = () => {
    scheduler.signal.throwIfAborted();
    params.assertCurrent();
  };
  const recover = (): Promise<void> => {
    if (scheduler.signal.aborted) {
      return Promise.resolve();
    }
    if (inFlight) {
      return inFlight;
    }
    retry?.cancel();
    retry = undefined;
    const work = params.track(async () => {
      const failures: unknown[] = [];
      try {
        current();
        const discovered = await params.discover();
        current();
        const { scopes, unavailable = [] } = discovered;
        failures.push(...unavailable);
        for (const error of unavailable) {
          warn(`Durable question source admission failed: ${String(error)}`);
        }
        for (const scope of scopes) {
          const key = JSON.stringify([scope.agentId, scope.storePath]);
          if (recovered.has(key)) {
            continue;
          }
          try {
            current();
            await params.recover(scope);
            current();
            recovered.add(key);
          } catch (error) {
            if (scheduler.signal.aborted) {
              return;
            }
            failures.push(error);
            warn(`Durable question store recovery failed: ${String(error)}`);
          }
        }
      } catch (error) {
        if (scheduler.signal.aborted) {
          return;
        }
        failures.push(error);
        warn(`Durable question discovery failed: ${String(error)}`);
      }
      passFailures = failures;
      if (failures.length > 0 && !scheduler.signal.aborted) {
        retry = scheduler.schedule({
          id: retryId,
          delayMs: retryDelayMs,
          run: () => recover(),
        });
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      } else {
        retryDelayMs = 1_000;
      }
      if (!preparationWork && !scheduler.signal.aborted) {
        const pending = params.pendingPreparation?.();
        if (pending) {
          // Preparation needs sidecars-ready, which the initial pass must not hold.
          // Observe its existing owner separately, then discover newly admitted stores.
          preparationWork = params.track(async () => {
            try {
              await racePromiseWithAbortSignal(pending, scheduler.signal);
              await inFlight;
              current();
              await recover();
            } catch (error) {
              if (!scheduler.signal.aborted) {
                preparationFailure = { error };
                warn(`Durable question admission readiness failed: ${String(error)}`);
              }
            }
          });
        }
      }
    });
    inFlight = work;
    initialWork ??= work;
    void work.then(
      () => {
        if (inFlight === work) {
          inFlight = undefined;
        }
      },
      () => {
        if (inFlight === work) {
          inFlight = undefined;
        }
      },
    );
    return work;
  };
  return {
    recover,
    waitForRecovery: async () => {
      current();
      await racePromiseWithAbortSignal(inFlight ?? initialWork ?? recover(), scheduler.signal);
      // The retained observer includes rediscovery, not just preparation. Startup
      // itself must return before sidecars-ready can release that preparation.
      if (preparationWork) {
        await racePromiseWithAbortSignal(preparationWork, scheduler.signal);
      }
      if (inFlight) {
        await racePromiseWithAbortSignal(inFlight, scheduler.signal);
      }
      current();
      const failures = [...passFailures, ...(preparationFailure ? [preparationFailure.error] : [])];
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "Durable question startup recovery remains unavailable.",
        );
      }
    },
    beginClose: scheduler.beginClose,
    stop: async () => {
      scheduler.beginClose();
      await Promise.all([scheduler.stop(), inFlight, preparationWork]);
    },
  };
}
