import { err, ok } from "@openclaw/normalization-core/result";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { captureOpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-cache.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
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
import { registerPluginStateEntry } from "./plugin-state-store.retention.js";
import {
  type PluginStateWorkerOperations,
  pluginStateWorkerOperations,
} from "./plugin-state-worker-contract.js";
import { capturePluginStateWorkerFailure } from "./plugin-state-worker-errors.js";

export function executePluginStateCommand(
  command: SqliteWorkerCommand<PluginStateWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { path: string },
  openDatabase: () => OpenClawStateDatabase,
  hasRetainedDatabase: boolean,
): PluginStateWorkerOperations[keyof PluginStateWorkerOperations]["output"] {
  const description = pluginStateWorkerOperations[command.type];
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
      return err(
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
    return ok(
      runOpenClawStateWriteTransaction(
        (store) => {
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
              return registerPluginStateEntry(store, command.input);
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
            default:
              throw new Error("Plugin-state read command entered its write path");
          }
        },
        { ...options, database },
      ),
    );
  } catch (error) {
    return err(
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
  }
}
