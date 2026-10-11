import { isGatewayRestartDrainError } from "../../../process/gateway-work-admission.js";
import { defaultRuntime } from "../../../runtime.js";
import { FOLLOWUP_DRAIN_FAILURES } from "./drain-failures.js";
import { FOLLOWUP_QUEUES, followupQueueSources } from "./state.js";
import { FollowupRunDeferredError, type FollowupRun } from "./types.js";

// Bounded retry policy for unclassified drain failures. The drain owner injects
// its scheduler so this module never imports drain.ts.
type FollowupQueueState = NonNullable<ReturnType<typeof FOLLOWUP_QUEUES.get>>;
type FollowupCallback = (run: FollowupRun) => Promise<void>;
type RescheduleFollowupDrain = (key: string, callback: FollowupCallback) => void;

const FOLLOWUP_DRAIN_RETRY_BASE_MS = 500;
const FOLLOWUP_DRAIN_RETRY_MAX_MS = 10_000;
const FOLLOWUP_DRAIN_MAX_FAILURES = 7;

function resolveFollowupDrainFailure(queue: FollowupQueueState, source: FollowupRun) {
  let failure = FOLLOWUP_DRAIN_FAILURES.get(source);
  if (!failure || failure.queue !== queue) {
    failure = { queue, failures: 0 };
    FOLLOWUP_DRAIN_FAILURES.set(source, failure);
  }
  return failure;
}

function scheduleFollowupDrainAfter(
  key: string,
  queue: FollowupQueueState,
  runFollowup: FollowupCallback,
  failures: number,
  reschedule: RescheduleFollowupDrain,
): void {
  const delayMs = Math.min(
    FOLLOWUP_DRAIN_RETRY_MAX_MS,
    FOLLOWUP_DRAIN_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1),
  );
  const cancel = () => {
    clearTimeout(timer);
    if (queue.retryTimer === timer) {
      delete queue.retryTimer;
    }
    queue.abortController.signal.removeEventListener("abort", cancel);
  };
  const timer = setTimeout(() => {
    cancel();
    if (FOLLOWUP_QUEUES.get(key) === queue && !queue.abortController.signal.aborted) {
      reschedule(key, runFollowup);
    }
  }, delayMs);
  queue.retryTimer = timer;
  queue.abortController.signal.addEventListener("abort", cancel, { once: true });
  timer.unref?.();
}

/** Identify failed work without logging prompt content. */
function describeFailedFollowupItem(item: FollowupRun): string {
  return `messageId=${item.messageId ?? "unknown"} channel=${item.originatingChannel ?? "unknown"} promptChars=${item.prompt.length}`;
}

/** Give every retained source a fresh budget after an accepted recovery command. */
export function resetFollowupDrainFailures(queue: FollowupQueueState): void {
  for (const source of followupQueueSources(queue)) {
    resolveFollowupDrainFailure(queue, source).failures = 0;
  }
  queue.drainFailureCount = 0;
  delete queue.drainSuspended;
}

/**
 * Wraps one drain generation's callback so each attempt records the exact
 * reserved sources and clears their budgets on success or classified retries.
 */
export function trackFollowupDrainAttempts(queue: FollowupQueueState, callback: FollowupCallback) {
  const tracker: { attemptedSources: FollowupRun[]; run: FollowupCallback } = {
    // Reservation owners expose the exact sources for individual, priority,
    // collected, and overflow deliveries before crossing the async callback.
    attemptedSources: [],
    run: async (run: FollowupRun) => {
      tracker.attemptedSources = [...queue.inFlight];
      const failures = tracker.attemptedSources.map((source) =>
        resolveFollowupDrainFailure(queue, source),
      );
      const clear = () => {
        for (const failure of failures) {
          failure.failures = 0;
        }
        queue.drainFailureCount = 0;
      };
      try {
        await callback(run);
      } catch (error) {
        if (error instanceof FollowupRunDeferredError || isGatewayRestartDrainError(error)) {
          clear();
        }
        throw error;
      }
      clear();
      tracker.attemptedSources = [];
    },
  };
  return tracker;
}

export function handleFollowupDrainFailure(params: {
  key: string;
  queue: FollowupQueueState;
  attemptedSources: FollowupRun[];
  callback: FollowupCallback;
  error: unknown;
  reschedule: RescheduleFollowupDrain;
}): void {
  const { key, queue, attemptedSources, callback, error, reschedule } = params;
  const attemptedFailures = new Set(
    attemptedSources.map((source) => resolveFollowupDrainFailure(queue, source)),
  );
  const pendingSources = [...followupQueueSources(queue)].filter((source) => {
    const failure = FOLLOWUP_DRAIN_FAILURES.get(source);
    return failure && attemptedFailures.has(failure);
  });
  // Admission may have consumed a failed aggregate already. Its error
  // must not spend the retry budget of untouched work behind it.
  if (attemptedSources.length > 0 && pendingSources.length === 0) {
    reschedule(key, callback);
    return;
  }
  // A canceled member of a failed collect batch no longer owns a retry.
  // Only failure identities still represented by pending work spend a budget.
  const pendingFailures = new Set(
    pendingSources.map((source) => resolveFollowupDrainFailure(queue, source)),
  );
  const failures =
    pendingFailures.size > 0
      ? Math.max(...[...pendingFailures].map((failure) => ++failure.failures))
      : (queue.drainFailureCount = (queue.drainFailureCount ?? 0) + 1);
  if (failures >= FOLLOWUP_DRAIN_MAX_FAILURES) {
    // Repetition is not evidence that accepted input is permanently invalid.
    // Park the queue without settling sources or consuming summary content.
    queue.drainSuspended = true;
    defaultRuntime.error?.(
      `followup queue suspended for ${key} after ${failures} consecutive drain failures; ` +
        `queued work retained and automatic retries stopped; use /queue reset after resolving the failure (${attemptedSources.map(describeFailedFollowupItem).join("; ") || "source not yet reserved"}): ${String(error)}`,
    );
  } else {
    scheduleFollowupDrainAfter(key, queue, callback, failures, reschedule);
  }
}
