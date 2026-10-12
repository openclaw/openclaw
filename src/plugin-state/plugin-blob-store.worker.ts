import type { DatabaseSync } from "node:sqlite";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import {
  pluginBlobClearInDatabase,
  pluginBlobDeleteInDatabase,
  pluginBlobDeleteExpiredInDatabase,
  pluginBlobDeleteExpiredKeyInDatabase,
  pluginBlobRegisterInDatabase,
  pluginBlobRegisterIfAbsentInDatabase,
  wrapPluginBlobError,
} from "./plugin-blob-store.sqlite.js";
import { pluginBlobWorkerOperations } from "./plugin-blob-worker-contract.js";

function write<Result>(
  type: keyof typeof pluginBlobWorkerOperations,
  { open, stateOptions }: WorkerOperationContext,
  apply: (db: DatabaseSync, env: NodeJS.ProcessEnv) => Result,
): Result {
  const options = stateOptions();
  const description = pluginBlobWorkerOperations[type];
  let opened = false;
  try {
    const database = open();
    opened = true;
    return runOpenClawStateWriteTransaction(({ db }) => apply(db, options.env), {
      ...options,
      database,
    });
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

type Input<Fn extends (db: DatabaseSync, input: never) => unknown> = Omit<Parameters<Fn>[1], "env">;

export const pluginBlobOperations = {
  "pluginBlob.register": (input: Input<typeof pluginBlobRegisterInDatabase>, context) =>
    write("pluginBlob.register", context, (db, env) =>
      pluginBlobRegisterInDatabase(db, { ...input, env }),
    ),
  "pluginBlob.registerIfAbsent": (
    input: Input<typeof pluginBlobRegisterIfAbsentInDatabase>,
    context,
  ) =>
    write("pluginBlob.registerIfAbsent", context, (db, env) =>
      pluginBlobRegisterIfAbsentInDatabase(db, { ...input, env }),
    ),
  "pluginBlob.delete": (input: Input<typeof pluginBlobDeleteInDatabase>, context) =>
    write("pluginBlob.delete", context, (db) => pluginBlobDeleteInDatabase(db, input)),
  "pluginBlob.deleteExpiredKey": (
    input: Input<typeof pluginBlobDeleteExpiredKeyInDatabase>,
    context,
  ) =>
    write("pluginBlob.deleteExpiredKey", context, (db, env) =>
      pluginBlobDeleteExpiredKeyInDatabase<unknown>(db, { ...input, env }),
    ),
  "pluginBlob.deleteExpired": (input: Input<typeof pluginBlobDeleteExpiredInDatabase>, context) =>
    write("pluginBlob.deleteExpired", context, (db, env) =>
      pluginBlobDeleteExpiredInDatabase<unknown>(db, { ...input, env }),
    ),
  "pluginBlob.clear": (input: Input<typeof pluginBlobClearInDatabase>, context) =>
    write("pluginBlob.clear", context, (db) => pluginBlobClearInDatabase(db, input)),
} satisfies WorkerOperationHandlers;

export type PluginBlobWorkerOperations = WorkerOperations<typeof pluginBlobOperations>;
