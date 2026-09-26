import { ZodError } from "zod";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { assertOpenClawStateLeaseWorkerOwnedInTransaction } from "../state/openclaw-state-lease-worker.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import {
  DeferredPluginMigrationConflictError,
  recordDeferredPluginMigrationsInTransaction,
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

export function recordDeferredPluginMigrationsInWorker(
  input: OpenClawStateWorkerOperations["plugins.deferredMigrations.record"]["input"],
  options: OpenClawStateDatabaseOptions,
): OpenClawStateWorkerOperations["plugins.deferredMigrations.record"]["output"] {
  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        assertOpenClawStateLeaseWorkerOwnedInTransaction(db, input.identity);
        const transitions = recordDeferredPluginMigrationsInTransaction(db, input);
        assertOpenClawStateLeaseWorkerOwnedInTransaction(db, input.identity, "write", "commit");
        return { kind: "recorded" as const, transitions };
      },
      options,
      { operationLabel: "state.plugin-migration-deferral" },
    );
  } catch (error) {
    if (error instanceof DeferredPluginMigrationConflictError) {
      return { kind: "conflict", pending: error.pending };
    }
    if (error instanceof ZodError) {
      return { kind: "invalid", issues: error.issues };
    }
    throw error;
  }
}
