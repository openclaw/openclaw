import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import {
  readDeferredPluginMigrationCompletions,
  readDeferredPluginMigrations,
} from "./deferred-plugin-migrations.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

export function readDeferredPluginMigrationsInWorker(
  command: Extract<
    SqliteWorkerCommand<OpenClawStateWorkerOperations>,
    { type: "plugins.deferredMigrations.read" | "plugins.deferredMigrations.completions.read" }
  >,
  options: { path: string; env: NodeJS.ProcessEnv },
) {
  return command.type === "plugins.deferredMigrations.read"
    ? readDeferredPluginMigrations({
        ...options,
        artifactPreservingReadOnly: command.input.artifactPreservingReadOnly,
      })
    : readDeferredPluginMigrationCompletions(options);
}
