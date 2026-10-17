import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db.js";

/** Release readers and close each database before removing its temporary directory. */
export function useUserStateFixture(prefix: string, releaseReaders = () => {}) {
  const paths: string[] = [];
  const roots = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      releaseReaders();
      vi.restoreAllMocks();
      for (const pathname of paths.splice(0)) {
        await closeOpenClawStateDatabaseByPathAsync(pathname);
      }
      cleanup();
    });
  });
  return (filename = "openclaw.sqlite") => {
    const path = join(roots.make(prefix), filename);
    paths.push(path);
    return { path };
  };
}
