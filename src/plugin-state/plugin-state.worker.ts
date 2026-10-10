import { err, ok } from "@openclaw/normalization-core/result";
import { requestSessionEntriesCurrentAdmission } from "../config/sessions/session-entry-current-admission.worker.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { captureOpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-cache.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
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
} from "./plugin-state-store.comparison.js";
import {
  withPluginStateDatabaseReadOnly,
  wrapPluginStateError,
} from "./plugin-state-store.database.js";
import { registerPluginStateSequencedJournalEntryInDatabase } from "./plugin-state-store.journal.js";
import {
  countLivePluginStateNamespaceEntries,
  deleteExpiredPluginStateEntries,
  deletePluginStateEntry,
  lookupPluginStateEntry,
} from "./plugin-state-store.kernel.js";
import {
  clearPluginStateNamespace,
  consumePluginStateEntry,
  deletePluginStateEntryIfEqual,
  movePluginStateEntries,
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
  type PluginStateWorkerOperations,
  pluginStateWorkerOperations,
} from "./plugin-state-worker-contract.js";
import { capturePluginStateWorkerFailure } from "./plugin-state-worker-errors.js";
import {
  clearRuntimeHealthEntries,
  hasRuntimeHealthEntriesToClear,
} from "./runtime-health-store.kernel.js";

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
  command: SqliteWorkerCommand<PluginStateWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { path: string },
  openDatabase: () => OpenClawStateDatabase,
  hasRetainedDatabase: boolean,
): PluginStateWorkerOperations[keyof PluginStateWorkerOperations]["output"] {
  const description = pluginStateWorkerOperations[command.type];
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
            const run = () => executePluginStateOperation(store, command.input, handler);
            return store.db.isTransaction ? run() : runSqliteDeferredTransactionSync(store.db, run);
          },
          options,
        );
        if (!result) {
          throw new Error("Plugin state operation source is no longer available");
        }
        return ok(result);
      }
      const database = openDatabase();
      return ok(
        runOpenClawStateWriteTransaction(
          (store) => {
            admit("transaction");
            const result = withPluginStateWorkerReceipt(
              store.db,
              () => executePluginStateOperation(store, command.input, handler),
              (completed): PluginStateOperationCommit => ({
                pluginStateOperation: {
                  receiptId: command.input.receiptId,
                  validUntil: completed.validUntil,
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
  if (
    command.type === "pluginState.lookup" ||
    command.type === "pluginState.lookupMany" ||
    command.type === "pluginState.entries" ||
    command.type === "pluginState.entriesInKeyRange" ||
    command.type === "pluginState.count"
  ) {
    try {
      switch (command.type) {
        case "pluginState.lookup":
          return ok(
            withPluginStateDatabaseReadOnly(
              "lookup",
              (store) => lookupPluginStateEntry(store, command.input),
              options,
            ),
          );
        case "pluginState.lookupMany": {
          const rows =
            withPluginStateDatabaseReadOnly(
              "lookup",
              (store) => lookupPluginStateEntries(store, command.input),
              options,
            ) ?? command.input.keys.map(() => ok(undefined));
          return ok(
            rows.map((row) => (row.ok ? row : err(capturePluginStateWorkerFailure(row.error)))),
          );
        }
        case "pluginState.entriesInKeyRange":
          return ok(
            withPluginStateDatabaseReadOnly(
              "entries",
              (store) => listPluginStateEntriesInKeyRange(store, command.input),
              options,
            ) ?? [],
          );
        case "pluginState.entries":
          return ok(
            withPluginStateDatabaseReadOnly(
              "entries",
              (store) => listPluginStateEntries(store, command.input),
              options,
            ) ?? [],
          );
        case "pluginState.count":
          return ok(
            withPluginStateDatabaseReadOnly(
              "count",
              ({ db }) =>
                countLivePluginStateNamespaceEntries(db, {
                  ...command.input,
                  now: Date.now(),
                }),
              options,
            ) ?? 0,
          );
      }
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
      runOpenClawStateWriteTransaction(
        (store) => {
          admit("transaction");
          withPluginStateWorkerReceipt(store.db, () =>
            deletePluginStateEntry(store.db, command.input),
          );
          admit("commit");
        },
        { ...options, database },
      );
    }
    return ok(
      runOpenClawStateWriteTransaction(
        (store) => {
          admit("transaction");
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
              case "pluginState.sweep":
                return deleteExpiredPluginStateEntries(store.db, Date.now());
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
