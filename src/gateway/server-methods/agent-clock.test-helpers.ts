import { expectDefined } from "@openclaw/normalization-core";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { vi } from "vitest";

const realSetTimeout = globalThis.setTimeout.bind(globalThis);

let dateOnlyFakeClockActive = false;

export function setDateOnlyFakeClockActive(active: boolean): void {
  dateOnlyFakeClockActive = active;
}

function waitForRealTimer(ms: number) {
  return new Promise<void>((resolve) => {
    realSetTimeout(resolve, ms);
  });
}

export async function waitForAssertion(assertion: () => void, timeoutMs = 2_000, stepMs = 5) {
  let lastError: unknown;
  for (let elapsed = 0; elapsed <= timeoutMs; elapsed += stepMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }

    await Promise.resolve();
    if (vi.isFakeTimers() && !dateOnlyFakeClockActive) {
      await vi.advanceTimersByTimeAsync(stepMs);
    } else {
      await waitForRealTimer(stepMs);
    }
  }
  throw toLintErrorObject(
    lastError ?? new Error("assertion did not pass in time"),
    "Non-Error thrown",
  );
}

export async function flushScheduledDispatchStep() {
  await Promise.resolve();
  if (vi.isFakeTimers() && !dateOnlyFakeClockActive) {
    await vi.runOnlyPendingTimersAsync();
  } else {
    await waitForRealTimer(15);
  }
  await Promise.resolve();
}

export async function waitForAcceptedRunDispatch(params: {
  respond: ReturnType<typeof vi.fn>;
  hasDispatched: () => boolean;
  hasTerminalResult?: () => boolean;
  initialRespondCallCount: number;
}) {
  const { respond } = params;
  const respondCallCount = respond.mock.calls.length;
  if (respondCallCount <= params.initialRespondCallCount) {
    return;
  }
  // A reused responder may retain an earlier accepted reply after this invocation
  // returns a cached terminal result. Only its latest new reply owns pending dispatch.
  const [ok, payload] = expectDefined(
    respond.mock.lastCall,
    "expected current invocation response",
  );
  if (ok !== true || (payload as { status?: string } | undefined)?.status !== "accepted") {
    return;
  }
  // Keep clock ownership through delayed acknowledgement timers, but fail explicitly if
  // accepted work never settles; an unbounded microtask loop can starve the test timeout.
  for (
    let pumps = 0;
    !params.hasDispatched() &&
    !params.hasTerminalResult?.() &&
    respond.mock.calls.length <= respondCallCount;
    pumps++
  ) {
    if (pumps === 1_000) {
      throw new Error("Accepted agent request did not dispatch or return a terminal response");
    }
    await flushScheduledDispatchStep();
  }
}
