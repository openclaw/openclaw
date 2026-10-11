import { resolveGlobalMap } from "../shared/global-singleton.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import { captureWorkspaceStateFilesystemGuard } from "./workspace-state-guard.js";
import { resolveCanonicalWorkspacePath } from "./workspace-state-identity.js";

const preparationQueues = resolveGlobalMap<string, StoreWriterQueue>(
  Symbol.for("openclaw.workspacePreparationQueues"),
);

/** Keep host filesystem preparation and its worker writes in one directory's FIFO interval. */
export function runWorkspacePreparation<T>(
  dir: string,
  prepare: (assertFilesystem: () => void) => Promise<T>,
): Promise<T> {
  const assertFilesystem = captureWorkspaceStateFilesystemGuard(dir, false);
  const canonicalDir = resolveCanonicalWorkspacePath(dir);
  assertFilesystem();
  return runQueuedStoreWrite({
    queues: preparationQueues,
    storePath: canonicalDir,
    label: "Workspace preparation",
    fn: async () => {
      assertFilesystem();
      return await prepare(assertFilesystem);
    },
  });
}
