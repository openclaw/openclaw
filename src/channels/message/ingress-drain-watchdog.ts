import { formatErrorMessage } from "../../infra/errors.js";
import { type ActiveHandlerState, IngressAdoptionLostError } from "./ingress-drain-state.js";
import { DEFAULT_INGRESS_RETRY_BASE_MS } from "./ingress-retry-policy.js";

/** Watchdog settlement retains its claim until dispatch quiesces or the drain retires. */
export function armIngressStallWatchdog<TPayload, TMetadata>(
  state: ActiveHandlerState<TPayload, TMetadata>,
  {
    now,
    adoptionStallTimeoutMs,
    isStopped,
    settlementObserversRetired,
    applyFailureDisposition,
    log,
    formatError = formatErrorMessage,
  }: {
    now: () => number;
    adoptionStallTimeoutMs: number;
    isStopped: () => boolean;
    settlementObserversRetired: Promise<void>;
    applyFailureDisposition: (
      claim: ActiveHandlerState<TPayload, TMetadata>["claim"],
      error: Error,
      beforeRetryRelease: () => Promise<void>,
    ) => Promise<void>;
    log: (message: string) => void;
    formatError?: (error: unknown) => string;
  },
): ReturnType<typeof setTimeout> {
  const waitForQuiescenceOrStop = async (task: Promise<void>): Promise<void> => {
    if (isStopped()) {
      throw new IngressAdoptionLostError("aborted");
    }
    // Abort and direct disposal both retire this watchdog-owned wait. Terminal
    // callbacks retain their separate late-settlement contract.
    await Promise.race([
      task,
      settlementObserversRetired.then(() => {
        throw new IngressAdoptionLostError("aborted");
      }),
    ]);
    if (isStopped()) {
      throw new IngressAdoptionLostError("aborted");
    }
  };

  const settleStalledClaim = async (timeoutError: Error, displayId: string) => {
    while (!isStopped() && state.phase !== "settled") {
      try {
        await state.settleOnce(async () => {
          await applyFailureDisposition(
            state.claim,
            timeoutError,
            async () => await waitForQuiescenceOrStop(state.quiescence.task),
          );
        });
      } catch (err) {
        if (isStopped()) {
          return;
        }
        log(
          `ingress drain: failed to settle stalled event ${displayId}; holding claim and retrying: ${formatError(err)}`,
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, DEFAULT_INGRESS_RETRY_BASE_MS);
          timer.unref?.();
        });
        continue;
      }
      return;
    }
  };

  return setTimeout(() => {
    // Pre-adoption only (dispatching OR deferred). Timer is not cleared by deferral.
    if (state.phase !== "dispatching" && state.phase !== "deferred") {
      return;
    }
    const ageMs = now() - state.startedAt;
    const displayId = state.eventId.replace(/^0+(?=\d)/, "") || state.eventId;
    const message = `Channel ingress claim→adoption stalled for event ${displayId} on lane ${state.laneKey} after ${ageMs}ms; applying retry policy (handler-timeout).`;
    const timeoutError = new Error(message);
    // Closed guillotine flag — catch must not string-sniff errors.
    state.guillotined = true;
    state.stallTimer = undefined;
    log(message);
    // Install settlement before aborting so synchronous terminal callbacks
    // can join the same durable release instead of returning early.
    const settlementTask = settleStalledClaim(timeoutError, displayId);
    state.stallSettlementTask = settlementTask;
    try {
      state.abortController.abort(timeoutError);
    } catch {
      // AbortController.abort is not fallible in practice.
    }
  }, adoptionStallTimeoutMs);
}
