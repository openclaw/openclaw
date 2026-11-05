import { AsyncWorkScope } from "../shared/async-work-scope.js";

/** Summary lanes and model fallbacks retain custody until descendant resources are released. */
export async function runSummaryWork<T>(signal: AbortSignal | undefined, run: () => Promise<T>) {
  const work = new AsyncWorkScope();
  const close = () => work.beginClose(signal?.reason);
  signal?.addEventListener("abort", close, { once: true });
  if (signal?.aborted) {
    close();
  }
  try {
    return await work.track(run);
  } finally {
    try {
      await AsyncWorkScope.runWhenAllIdle(
        () => [work],
        () => work.drain(),
      );
    } finally {
      signal?.removeEventListener("abort", close);
    }
  }
}
