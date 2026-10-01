import type { ReplyDispatcher, ReplyDispatchReceipt } from "./reply-dispatcher.types.js";

export async function waitForReplyDispatcherIdle(
  dispatcher: Pick<ReplyDispatcher, "waitForIdle">,
  abortSignal?: AbortSignal,
): Promise<ReplyDispatchReceipt | undefined> {
  if (!abortSignal) {
    return (await dispatcher.waitForIdle()) || undefined;
  }
  if (abortSignal.aborted) {
    return undefined;
  }
  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<undefined>((resolve) => {
    const onAbort = () => resolve(undefined);
    abortSignal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
  });
  try {
    return (await Promise.race([dispatcher.waitForIdle(), aborted])) || undefined;
  } finally {
    removeAbortListener?.();
  }
}
