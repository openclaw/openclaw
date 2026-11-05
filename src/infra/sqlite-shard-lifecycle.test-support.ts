export function defer(cleanup: () => void): Disposable {
  return { [Symbol.dispose]: cleanup };
}

export function deferAsync(cleanup: () => Promise<unknown>): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      await cleanup();
    },
  };
}
import { afterEach } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";

export function useSqliteTempDirs(beforeCleanup?: () => unknown, afterCleanup?: () => unknown) {
  const dirs = createTempDirTracker();
  afterEach(async () => {
    try {
      await beforeCleanup?.();
      dirs.cleanup();
    } finally {
      await afterCleanup?.();
    }
  });
  return dirs;
}
