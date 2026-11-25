import { createTempDirTracker } from "../../test/helpers/temp-dir.js";

/** Async adapter for callers of the shared temporary-directory owner. */
export function createTrackedTempDirs() {
  const tracker = createTempDirTracker();
  return {
    async make(prefix: string): Promise<string> {
      return tracker.make(prefix);
    },
    async cleanup(): Promise<void> {
      tracker.cleanup();
    },
  };
}
