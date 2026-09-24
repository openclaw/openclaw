import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  pluginBlobClearInDatabase,
  pluginBlobDeleteInDatabase,
  pluginBlobDeleteExpiredInDatabase,
  pluginBlobDeleteExpiredKeyInDatabase,
  pluginBlobRegisterInDatabase,
  pluginBlobRegisterIfAbsentInDatabase,
  wrapPluginBlobError,
} from "./plugin-blob-store.sqlite.js";
import {
  pluginBlobWorkerOperations,
  type PluginBlobWorkerOperations,
} from "./plugin-blob-worker-contract.js";

export function executePluginBlobCommand(
  command: SqliteWorkerCommand<PluginBlobWorkerOperations>,
  databasePath: string,
  openDatabase: () => OpenClawStateDatabase,
): PluginBlobWorkerOperations[keyof PluginBlobWorkerOperations]["output"] {
  const options = { path: databasePath, env: getSqliteWorkerStateContext().environment };
  const description = pluginBlobWorkerOperations[command.type];
  let opened = false;
  try {
    const database = openDatabase();
    opened = true;
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        switch (command.type) {
          case "pluginBlob.register":
            return pluginBlobRegisterInDatabase(db, { ...command.input, env: options.env });
          case "pluginBlob.registerIfAbsent":
            return pluginBlobRegisterIfAbsentInDatabase(db, {
              ...command.input,
              env: options.env,
            });
          case "pluginBlob.delete":
            return pluginBlobDeleteInDatabase(db, command.input);
          case "pluginBlob.deleteExpiredKey":
            return pluginBlobDeleteExpiredKeyInDatabase(db, {
              ...command.input,
              env: options.env,
            });
          case "pluginBlob.deleteExpired":
            return pluginBlobDeleteExpiredInDatabase(db, { ...command.input, env: options.env });
          case "pluginBlob.clear":
            return pluginBlobClearInDatabase(db, command.input);
        }
      },
      { ...options, database },
    );
  } catch (error) {
    throw wrapPluginBlobError(
      error,
      description.operation,
      opened ? "PLUGIN_BLOB_WRITE_FAILED" : "PLUGIN_BLOB_OPEN_FAILED",
      opened ? description.message : "Failed to open plugin blob store.",
      options.env,
      options.path,
    );
  }
}
