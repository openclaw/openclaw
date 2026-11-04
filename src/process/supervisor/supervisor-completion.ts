import { createDeferredCore } from "../../shared/deferred.js";
import type { SpawnInput, SpawnProcessAdapter } from "./types.js";

/** Bound inherited output after root exit; descendant cleanup retains its own wait. */
export async function waitForExecRootCompletion(
  input: SpawnInput,
  adapter: SpawnProcessAdapter,
  isCancelled: () => boolean,
) {
  if (
    input.executionIntent !== "agent-tool" ||
    input.mode !== "child" ||
    process.platform === "win32" ||
    input.cleanupOwnership === "external"
  ) {
    return await adapter.wait();
  }
  const rootExit = createDeferredCore<Awaited<ReturnType<SpawnProcessAdapter["wait"]>>>();
  let timer: NodeJS.Timeout | undefined;
  adapter.onExit?.((code, signal) => {
    timer = setTimeout(() => {
      if (!isCancelled()) {
        rootExit.resolve({ code, signal });
      }
    }, 250);
    timer.unref();
  });
  try {
    // Settlement fences output delivery. Keep the transport draining under its
    // native cleanup owner so completion never kills a background descendant.
    return await Promise.race([adapter.wait(), rootExit.promise]);
  } finally {
    clearTimeout(timer);
  }
}
