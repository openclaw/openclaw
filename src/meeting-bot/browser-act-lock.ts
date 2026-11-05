import { raceWithTimeout } from "../../packages/retry/src/index.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { MeetingBrowserRequestCaller } from "./platform-adapter-contract.js";

const browserActLock = new KeyedAsyncQueue();
const BROWSER_ACT_TIMEOUT_MESSAGE =
  "Meeting browser operation timed out waiting for browser tab control.";

// Browser evaluate calls can await page APIs and interleave in one tab. Keep
// ownership, audio, caption, transcript, and leave mutations process-serialized.
export async function runMeetingBrowserAct<T>(params: {
  /** Absolute deadline in the performance.now() clock domain. */
  deadline: number;
  operation: (remainingMs: number) => Promise<T>;
  targetId: string;
}): Promise<T> {
  const waitMs = Math.floor(params.deadline - performance.now());
  if (waitMs <= 0) {
    throw new Error(BROWSER_ACT_TIMEOUT_MESSAGE);
  }
  const { promise: acquisition, resolve: markAcquired } = createDeferredCore();
  const queued = browserActLock.enqueue(params.targetId, async () => {
    const remainingMs = Math.floor(params.deadline - performance.now());
    if (remainingMs <= 0) {
      throw new Error(BROWSER_ACT_TIMEOUT_MESSAGE);
    }
    markAcquired();
    return await params.operation(remainingMs);
  });
  // The acquisition race may return before this queued no-op reaches the lock.
  // Keep its eventual deadline rejection observed without masking caller errors.
  void queued.catch(() => undefined);
  await raceWithTimeout(acquisition, waitMs, () => {
    throw new Error(BROWSER_ACT_TIMEOUT_MESSAGE);
  });
  return await queued;
}

export function evaluateMeetingBrowser(params: {
  callBrowser: MeetingBrowserRequestCaller;
  deadline: number;
  targetId: string;
  script: () => string;
}): Promise<unknown> {
  return runMeetingBrowserAct({
    deadline: params.deadline,
    targetId: params.targetId,
    operation: (timeoutMs) =>
      params.callBrowser({
        method: "POST",
        path: "/act",
        body: { kind: "evaluate", targetId: params.targetId, fn: params.script() },
        timeoutMs,
      }),
  });
}
