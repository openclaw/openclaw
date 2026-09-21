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
