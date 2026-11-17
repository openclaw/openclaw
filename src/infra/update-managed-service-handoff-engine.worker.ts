import { existsSync } from "node:fs";
import { readBackupEngine } from "./database-engine/physical-store.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "./update-managed-service-handoff-lease.js";
import { serveWorkerTasks } from "./worker-task-server.js";

// Snapshot inspection and installation lease probes stay off the serving thread.
serveWorkerTasks<
  "sqlite" | "postgres" | undefined | boolean,
  string | { installRoot: string; serviceManagerEnv: NodeJS.ProcessEnv }
>((input) => {
  if (typeof input === "string") {
    return existsSync(input) ? readBackupEngine(input).engine : undefined;
  }
  const store = createManagedHandoffLeaseStore({
    databasePath: resolveManagedUpdateLeaseDatabasePath(),
    serviceManagerEnv: input.serviceManagerEnv,
  });
  const held = store.read(input.installRoot);
  return (
    held.kind === "current" &&
    [held.lease.executor, held.lease.helper].some((holder) =>
      store.isProcessIdentityCurrent(holder),
    )
  );
});
