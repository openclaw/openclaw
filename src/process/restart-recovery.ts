/**
 * Returns an iteration hook for in-process restart loops.
 * The first call is considered initial startup and does nothing.
 * Each subsequent call represents a restart iteration and invokes `onRestart`.
 */
export function createRestartIterationHook(onRestart: () => void): () => boolean {
  let isFirstIteration = true;
  return () => {
    if (isFirstIteration) {
      isFirstIteration = false;
      return false;
    }
    onRestart();
    return true;
  };
}
