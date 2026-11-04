import path from "node:path";
import { materializeErrorStack } from "./error-graph-internal.js";
import { isPathInside } from "./path-guards.js";

/**
 * Per-path latch for terminal database-open failures (newer schema, proven
 * corruption). Recording quarantines the path: any live handle is closed and
 * every later open fails fast until doctor repairs the file and clears it.
 */
export function createSqliteTerminalOpenLatch(options: {
  closeByPath: (pathname: string, error: Error) => void;
}) {
  const failures = new Map<string, Error>();

  return {
    /** Read the owner's recorded fact without running filesystem or database inspection. */
    peek: (pathname: string): Error | undefined => failures.get(path.resolve(pathname)),
    get: (pathname: string): Error | undefined => failures.get(path.resolve(pathname)),
    record: (pathname: string, error: Error): void => {
      const resolvedPath = path.resolve(pathname);
      materializeErrorStack(error);
      failures.set(resolvedPath, error);
      options.closeByPath(resolvedPath, error);
    },
    clear: (pathname: string): void => {
      failures.delete(path.resolve(pathname));
    },
    clearAll: (rootPath?: string): void => {
      for (const pathname of failures.keys()) {
        if (rootPath === undefined || isPathInside(rootPath, pathname)) {
          failures.delete(pathname);
        }
      }
    },
  };
}
