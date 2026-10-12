import { createDeferredCore } from "../../shared/deferred.js";
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
  const aborted = createDeferredCore<undefined>();
  const onAbort = () => aborted.resolve(undefined);
  abortSignal.addEventListener("abort", onAbort, { once: true });
  try {
    return (await Promise.race([dispatcher.waitForIdle(), aborted.promise])) || undefined;
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }
}
