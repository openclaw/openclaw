import { existsSync } from "node:fs";
import { readBackupEngine } from "./database-engine/physical-store.js";
import { serveWorkerTasks } from "./worker-task-server.js";

// Snapshot inspection may copy a large SQLite file; keep it off the calling thread.
serveWorkerTasks<"sqlite" | "postgres" | undefined, string>((pathname) => {
  return existsSync(pathname) ? readBackupEngine(pathname).engine : undefined;
});
