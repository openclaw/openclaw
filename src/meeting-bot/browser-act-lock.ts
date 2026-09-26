import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";

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
  let acquired = false;
  let markAcquired: (() => void) | undefined;
  const acquisition = new Promise<void>((resolve) => {
    markAcquired = resolve;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const queued = browserActLock.enqueue(params.targetId, async () => {
    const remainingMs = Math.floor(params.deadline - performance.now());
    if (remainingMs <= 0) {
      throw new Error(BROWSER_ACT_TIMEOUT_MESSAGE);
    }
    acquired = true;
    clearTimeout(timeout);
    markAcquired?.();
    return await params.operation(remainingMs);
  });
  // The acquisition race may return before this queued no-op reaches the lock.
  // Keep its eventual deadline rejection observed without masking caller errors.
  void queued.catch(() => undefined);
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      if (!acquired) {
        reject(new Error(BROWSER_ACT_TIMEOUT_MESSAGE));
      }
    }, waitMs);
  });
  try {
    await Promise.race([acquisition, expired]);
  } finally {
    clearTimeout(timeout);
  }
  return await queued;
}
