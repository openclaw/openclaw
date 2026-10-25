import { err, ok } from "@openclaw/normalization-core/result";
import { requestSessionEntriesCurrentAdmission } from "../config/sessions/session-entry-current-admission.worker.js";
import { runSqliteReadSnapshotSync } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { captureOpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-cache.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import { hasOpenClawStateTablesBeyondStartupCheckpoint } from "../state/openclaw-state-db-schema-helpers.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  PluginStateOperationCommit,
  PluginStateOperationInput,
} from "./plugin-state-operation-contract.js";
import { executePluginStateOperation } from "./plugin-state-operation.kernel.js";
import { withPluginStateWorkerReceipt } from "./plugin-state-publication.js";
import {
  compareAndApplyPluginStateEntry,
  observePluginStateEntry,
} from "./plugin-state-store.comparison.worker.js";
import {
  isMissingPluginStateTableError,
  withPluginStateDatabaseReadOnly,
  wrapPluginStateError,
} from "./plugin-state-store.database.js";
import { registerPluginStateSequencedJournalEntryInDatabase } from "./plugin-state-store.journal.js";
import {
  deletePluginStateEntry,
  lookupPluginStateEntry,
  countLivePluginStateNamespaceEntries,
  type PluginStateDatabase,
} from "./plugin-state-store.kernel.js";
import { movePluginStateEntries } from "./plugin-state-store.moves.worker.js";
import {
  clearPluginStateNamespace,
  consumePluginStateEntry,
  deletePluginStateEntryIfEqual,
  registerPluginStateEntryIfAbsent,
} from "./plugin-state-store.mutations.js";
import {
  listPluginStateEntries,
  listPluginStateEntriesInKeyRange,
  lookupPluginStateEntries,
} from "./plugin-state-store.reads.js";
import {
  readPluginStateRetention,
  registerPluginStateEntry,
} from "./plugin-state-store.retention.js";
import type {
  PluginStateOperationDefinitions,
  PluginStateOperationHandler,
} from "./plugin-state-store.types.js";
import {
  type PluginStateWriteOperations,
  type PluginStateReadCommand,
  type PluginStateReadResult,
  pluginStateWorkerOperations,
} from "./plugin-state-worker-contract.js";
import { capturePluginStateWorkerFailure } from "./plugin-state-worker-errors.js";
import {
  clearRuntimeHealthEntries,
  hasRuntimeHealthEntriesToClear,
} from "./runtime-health-store.kernel.js";

export function readPluginStateCommand(
  store: PluginStateDatabase,
  command: PluginStateReadCommand,
): PluginStateReadResult {
  const description = pluginStateWorkerOperations[command.type];
  try {
    switch (command.type) {
      case "pluginState.lookup":
        return { type: command.type, result: ok(lookupPluginStateEntry(store, command.input)) };
      case "pluginState.lookupMany":
        return {
          type: command.type,
          result: ok(
            lookupPluginStateEntries(store, command.input).map((row) =>
              row.ok ? row : err(capturePluginStateWorkerFailure(row.error)),
            ),
          ),
        };
      case "pluginState.entries":
        return { type: command.type, result: ok(listPluginStateEntries(store, command.input)) };
      case "pluginState.entriesInKeyRange":
        return {
          type: command.type,
          result: ok(listPluginStateEntriesInKeyRange(store, command.input)),
        };
      default:
        return {
          type: command.type,
          result: ok(
            countLivePluginStateNamespaceEntries(store.db, { ...command.input, now: Date.now() }),
          ),
        };
    }
  } catch (error) {
    // Lease bootstrap precedes creation of the plugin-state table; other missing tables are damage.
    if (
      isMissingPluginStateTableError(error) &&
      !hasOpenClawStateTablesBeyondStartupCheckpoint(store.db)
    ) {
      return {
        type: command.type,
        result: ok(
          command.type === "pluginState.lookup"
            ? undefined
            : command.type === "pluginState.count"
              ? 0
              : command.type === "pluginState.lookupMany"
                ? command.input.keys.map(() => ok(undefined))
                : [],
        ),
      };
    }
    return {
      type: command.type,
      result: err(
        capturePluginStateWorkerFailure(
          wrapPluginStateError(
            error,
            description.operation,
            description.code,
            description.message,
            store.path,
          ),
        ),
      ),
    };
  }
}

const operationHandlers = new Map<
  string,
  PluginStateOperationHandler<PluginStateOperationDefinitions>
>();

function operationHandlerKey(input: PluginStateOperationInput): string {
  return JSON.stringify([input.module.modulePath, input.module.boundaryRoot, input.exportName]);
}

/** Load plugin code before entering any native read or write transaction. */
export async function preparePluginStateOperation(input: PluginStateOperationInput): Promise<void> {
  const key = operationHandlerKey(input);
  if (operationHandlers.has(key)) {
    return;
  }
  const { loadValidatedPublicSurfaceModule } = await import("../plugins/public-surface-loader.js");
  const loaded = loadValidatedPublicSurfaceModule({
    ...input.module,
    surfaceLabel: "plugin state operation",
    capturedSource: true,
  });
  const handler: unknown = Reflect.get(loaded, input.exportName);
  if (typeof handler !== "function") {
    throw new Error("Plugin state operation module must export a synchronous handler");
  }
  operationHandlers.set(
    key,
    // SAFETY: The registered plugin owns its operation input/output contract; runtime enforces sync settlement.
    handler as PluginStateOperationHandler<PluginStateOperationDefinitions>,
  );
}

export function executePluginStateCommand(
  command: SqliteWorkerCommand<PluginStateWriteOperations>,
  options: OpenClawStateDatabaseOptions & { path: string },
  openDatabase: () => OpenClawStateDatabase,
  hasRetainedDatabase: boolean,
): PluginStateWriteOperations[keyof PluginStateWriteOperations]["output"] {
  const description = pluginStateWorkerOperations[command.type];
  // Initial grants may wait for the host, so request them before taking the writer.
  // Commit grants still recheck session authority inside the transaction.
  const admit = (stage: "transaction" | "commit") =>
    requestSessionEntriesCurrentAdmission(command.input?.sessionEntryCurrentSources, {
      stage,
      facts: undefined,
    });
  const failure = (error: unknown) =>
    err(
      capturePluginStateWorkerFailure(
        wrapPluginStateError(
          error,
          description.operation,
          description.code,
          description.message,
          options.path,
        ),
      ),
    );
  if (command.type === "pluginState.executeOperation") {
    try {
      const handler = operationHandlers.get(operationHandlerKey(command.input));
      if (!handler) {
        throw new Error("Plugin state operation was not prepared");
      }
      if (command.input.writeStores.length === 0) {
        const result = withPluginStateDatabaseReadOnly(
          "lookup",
          (store) => {
            const shortcut = command.input.ifEmpty;
            if (shortcut) {
              const probe = executePluginStateOperation(
                store,
                command.input,
                (_command, tx) => tx.entries(shortcut.store).length === 0,
              );
              if (probe.value) {
                return { ...probe, value: shortcut.value };
              }
            }
            const run = () => executePluginStateOperation(store, command.input, handler);
            return store.db.isTransaction ? run() : runSqliteReadSnapshotSync(store.db, run);
          },
          options,
        );
        if (!result) {
          throw new Error("Plugin state operation source is no longer available");
        }
        return ok(result);
      }
      const database = openDatabase();
      admit("transaction");
      return ok(
        runOpenClawStateWriteTransaction(
          (store) => {
            const result = withPluginStateWorkerReceipt(
              store.db,
              () => executePluginStateOperation(store, command.input, handler),
              (): PluginStateOperationCommit => ({
                pluginStateOperation: {
                  receiptId: command.input.receiptId,
                },
              }),
            );
            admit("commit");
            return result;
          },
          { ...options, database },
        ),
      );
    } catch (error) {
      return failure(error);
    }
  }
  if (command.type === "pluginState.clearRuntimeHealth") {
    try {
      // An absent health mirror must not open or upgrade a native-only state database.
      // A positive observation still rereads current rows inside the write transaction.
      const present = withPluginStateDatabaseReadOnly(
        "entries",
        (store) => hasRuntimeHealthEntriesToClear(store, command.input),
        options,
      );
      if (!present) {
        return ok(undefined);
      }
    } catch (error) {
      return failure(error);
    }
  }
  let database: OpenClawStateDatabase;
  try {
    database = openDatabase();
  } catch (error) {
    return err(
      capturePluginStateWorkerFailure(
        wrapPluginStateError(
          error,
          description.operation,
          hasRetainedDatabase ? description.code : "PLUGIN_STATE_OPEN_FAILED",
          hasRetainedDatabase ? description.message : "Failed to open the plugin state database.",
          options.path,
        ),
      ),
    );
  }
  try {
    if (command.type === "pluginState.replaceEntry") {
      // Replacing an approval first revokes its predecessor, even if registration fails.
      admit("transaction");
      runOpenClawStateWriteTransaction(
        (store) => {
          withPluginStateWorkerReceipt(store.db, () =>
            deletePluginStateEntry(store.db, command.input),
          );
          admit("commit");
        },
        { ...options, database },
      );
    }
    admit("transaction");
    return ok(
      runOpenClawStateWriteTransaction(
        (store) => {
          const result = withPluginStateWorkerReceipt(store.db, () => {
            switch (command.type) {
              case "pluginState.appendJournal":
                return registerPluginStateSequencedJournalEntryInDatabase(store, command.input);
              case "pluginState.observe":
                return observePluginStateEntry(
                  store,
                  command.input,
                  captureOpenClawStateDatabaseReadAdmission(store.path).identity.key,
                );
              case "pluginState.compareUpdate":
              case "pluginState.compareDelete":
                return compareAndApplyPluginStateEntry(
                  store,
                  command.input,
                  captureOpenClawStateDatabaseReadAdmission(store.path).identity.key,
                );
              case "pluginState.moveEntries":
                return movePluginStateEntries(store, command.input);
              case "pluginState.register":
              case "pluginState.replaceEntry":
                return registerPluginStateEntry(store, command.input);
              case "pluginState.replace": {
                clearPluginStateNamespace(store.db, command.input);
                if (command.input.entries.length === 0) {
                  return undefined;
                }
                const retention = readPluginStateRetention(store.db, {
                  ...command.input,
                  now: Date.now(),
                });
                for (const entry of command.input.entries) {
                  registerPluginStateEntry(store, { ...command.input, ...entry }, retention);
                }
                return undefined;
              }
              case "pluginState.registerIfAbsent":
                return registerPluginStateEntryIfAbsent(store, command.input);
              case "pluginState.deleteIfEqual":
                return deletePluginStateEntryIfEqual(store, command.input);
              case "pluginState.consume":
                return consumePluginStateEntry(store, command.input);
              case "pluginState.delete":
                return deletePluginStateEntry(store.db, command.input) > 0;
              case "pluginState.clear":
                return clearPluginStateNamespace(store.db, command.input);
              case "pluginState.clearRuntimeHealth":
                return clearRuntimeHealthEntries(store, command.input);
              default:
                throw new Error("Plugin-state read command entered its write path");
            }
          });
          admit("commit");
          return result;
        },
        { ...options, database },
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
