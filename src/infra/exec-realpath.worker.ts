import { resolvePathPrefixSync } from "@openclaw/fs-safe/advanced";
import { safeRealpathSync } from "@openclaw/fs-safe/path";
import type { ExecRealpathInput } from "./exec-realpath-worker.js";
import { withWorkerFsSafeNativeMode } from "./worker-fs-safe.js";
import { serveWorkerTasks } from "./worker-task-server.js";

serveWorkerTasks<string | undefined, ExecRealpathInput>(({ path, mode, ordinary }) =>
  withWorkerFsSafeNativeMode(mode, () => {
    try {
      if (ordinary) {
        return safeRealpathSync(path) ?? undefined;
      }
      const resolved = resolvePathPrefixSync(path);
      return resolved.unresolvedSegments.length === 0 ? resolved.existingPath : undefined;
    } catch {
      // The former safe canonicalization owner reports unavailable paths without retiring.
      return undefined;
    }
  }),
);
