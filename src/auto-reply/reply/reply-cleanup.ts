import type { QueuedReplyLifecycle } from "../get-reply-options.types.js";

export async function runWithReplyCleanup<T>(
  run: () => Promise<T>,
  cleanup: (() => Promise<void>) | undefined,
): Promise<T> {
  try {
    return await run();
  } finally {
    await cleanup?.();
  }
}

/** Defers a best-effort cleanup until a queued followup has finished consuming its inputs. */
export function withQueuedReplyCleanup(
  lifecycle: QueuedReplyLifecycle | undefined,
  cleanup: (() => Promise<void>) | undefined,
): QueuedReplyLifecycle | undefined {
  if (!cleanup) {
    return lifecycle;
  }
  return {
    ...lifecycle,
    onComplete: () => {
      try {
        lifecycle?.onComplete?.();
      } finally {
        void cleanup();
      }
    },
  };
}
