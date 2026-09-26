import { serialize } from "node:v8";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import {
  reserveSqliteWorkerInputPreparation,
  type SqliteWorkerInputPreparation,
} from "../infra/sqlite-worker-store.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { wrapPluginBlobError } from "./plugin-blob-store.sqlite.js";
import type { PluginBlobEntry, PluginBlobEntryInfo } from "./plugin-blob-store.types.js";
import {
  pluginBlobWorkerOperations,
  type PluginBlobWorkerOperations,
  type PluginBlobReadCommand,
} from "./plugin-blob-worker-contract.js";

type Scope = Pick<SqliteWorkerStore<PluginBlobWorkerOperations>, "execute">;
type Input<Key extends keyof PluginBlobWorkerOperations> =
  PluginBlobWorkerOperations[Key]["input"] & { env?: NodeJS.ProcessEnv };

async function execute<T>(
  env: NodeJS.ProcessEnv | undefined,
  name: keyof PluginBlobWorkerOperations,
  dispatch: (scope: Scope) => Promise<T>,
  prepare?: () => SqliteWorkerInputPreparation,
): Promise<T> {
  const databasePath = resolveOpenClawStateSqlitePath(env ?? process.env);
  const description = pluginBlobWorkerOperations[name];
  let dispatched = false;
  let preparation: SqliteWorkerInputPreparation | undefined;
  try {
    preparation = prepare?.();
    const context = captureOpenClawStateWorkerContext({ path: databasePath, env });
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    return await runOpenClawStateWorkerOperation(
      context,
      async (scope: Scope) => {
        dispatched = true;
        return await (preparation ? preparation.handoff(() => dispatch(scope)) : dispatch(scope));
      },
      { assertCurrent: preparation?.assertCurrent },
    );
  } catch (error) {
    throw wrapPluginBlobError(
      error,
      description.operation,
      dispatched ? "PLUGIN_BLOB_WRITE_FAILED" : "PLUGIN_BLOB_OPEN_FAILED",
      dispatched ? description.message : "Failed to open plugin blob store.",
      env,
      databasePath,
    );
  } finally {
    preparation?.release();
  }
}

function captureRegistrationInput(
  type: "pluginBlob.register" | "pluginBlob.registerIfAbsent",
  input: PluginBlobWorkerOperations["pluginBlob.register"]["input"],
): SqliteWorkerInputPreparation {
  const metadataBytes = serialize({
    type,
    input: { ...input, bytes: new Uint8Array() },
  }).byteLength;
  const preparation = reserveSqliteWorkerInputPreparation(input.bytes.byteLength + metadataBytes);
  try {
    input.bytes = Uint8Array.from(input.bytes);
    return preparation;
  } catch (error) {
    preparation.release();
    throw error;
  }
}

export function registerPluginBlobInWorker(params: Input<"pluginBlob.register">): Promise<void> {
  const { env, ...input } = params;
  return execute(
    env,
    "pluginBlob.register",
    (scope) => scope.execute({ type: "pluginBlob.register", input }),
    () => captureRegistrationInput("pluginBlob.register", input),
  );
}

export function registerPluginBlobIfAbsentInWorker(
  params: Input<"pluginBlob.registerIfAbsent">,
): Promise<boolean> {
  const { env, ...input } = params;
  return execute(
    env,
    "pluginBlob.registerIfAbsent",
    (scope) => scope.execute({ type: "pluginBlob.registerIfAbsent", input }),
    () => captureRegistrationInput("pluginBlob.registerIfAbsent", input),
  );
}

export function deletePluginBlobInWorker(params: Input<"pluginBlob.delete">): Promise<boolean> {
  const { env, ...input } = params;
  return execute(env, "pluginBlob.delete", (scope) =>
    scope.execute({ type: "pluginBlob.delete", input }),
  );
}

export async function deleteExpiredPluginBlobKeyInWorker<TMetadata>(
  params: Input<"pluginBlob.deleteExpiredKey">,
): Promise<PluginBlobEntryInfo<TMetadata> | undefined> {
  const { env, ...input } = params;
  const entry = await execute(env, "pluginBlob.deleteExpiredKey", (scope) =>
    scope.execute({ type: "pluginBlob.deleteExpiredKey", input }),
  );
  // SAFETY: The plugin namespace owns the metadata type; its kernel validates stored JSON.
  return entry as PluginBlobEntryInfo<TMetadata> | undefined;
}

export async function deleteExpiredPluginBlobsInWorker<TMetadata>(
  params: Input<"pluginBlob.deleteExpired">,
): Promise<PluginBlobEntryInfo<TMetadata>[]> {
  const { env, ...input } = params;
  const entries = await execute(env, "pluginBlob.deleteExpired", (scope) =>
    scope.execute({ type: "pluginBlob.deleteExpired", input }),
  );
  // SAFETY: The plugin namespace owns the metadata type; its kernel validates stored JSON.
  return entries as PluginBlobEntryInfo<TMetadata>[];
}

export function clearPluginBlobsInWorker(params: Input<"pluginBlob.clear">): Promise<void> {
  const { env, ...input } = params;
  return execute(env, "pluginBlob.clear", (scope) =>
    scope.execute({ type: "pluginBlob.clear", input }),
  );
}

function readPluginBlob(command: PluginBlobReadCommand, env?: NodeJS.ProcessEnv) {
  const databasePath = resolveOpenClawStateSqlitePath(env ?? process.env);
  const operation = command.type === "pluginBlob.lookup" ? "lookup" : "entries";
  // This call captures and retains the selected source before any await.
  return executeExistingOpenClawStateRead({ path: databasePath, env }, command, {
    mapError: (error, phase) =>
      wrapPluginBlobError(
        error,
        operation,
        phase === "before-read" ? "PLUGIN_BLOB_OPEN_FAILED" : "PLUGIN_BLOB_READ_FAILED",
        phase === "before-read"
          ? "Failed to open plugin blob store."
          : operation === "lookup"
            ? "Failed to read plugin blob entry."
            : "Failed to list plugin blob entries.",
        env,
        databasePath,
      ),
  });
}

export async function lookupPluginBlobInWorker<TMetadata>(params: {
  pluginId: string;
  namespace: string;
  key: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginBlobEntry<TMetadata> | undefined> {
  const { env, ...input } = params;
  const reply = await readPluginBlob({ type: "pluginBlob.lookup", input }, env);
  if (reply === undefined) {
    return undefined;
  }
  if (reply.ok && reply.type === "pluginBlob.lookup") {
    // SAFETY: The plugin namespace owns metadata shape; the read kernel validates JSON.
    return reply.value as PluginBlobEntry<TMetadata> | undefined;
  }
  throw new Error("Unexpected plugin blob lookup reply");
}

export async function listPluginBlobsInWorker<TMetadata>(params: {
  pluginId: string;
  namespace: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PluginBlobEntryInfo<TMetadata>[]> {
  const { env, ...input } = params;
  const reply = await readPluginBlob({ type: "pluginBlob.entries", input }, env);
  if (reply === undefined) {
    return [];
  }
  if (reply.ok && reply.type === "pluginBlob.entries") {
    // SAFETY: The plugin namespace owns metadata shape; the read kernel validates JSON.
    return reply.value as PluginBlobEntryInfo<TMetadata>[];
  }
  throw new Error("Unexpected plugin blob entries reply");
}
