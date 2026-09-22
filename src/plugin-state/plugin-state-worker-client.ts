import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { wrapPluginStateError } from "./plugin-state-store.sqlite.js";
import type { PluginStateStoreError } from "./plugin-state-store.types.js";
import {
  pluginStateWorkerOperations,
  type PluginStateWorkerOperations,
} from "./plugin-state-worker-contract.js";
import {
  restorePluginStateWorkerFailure,
  type PluginStateWorkerFailure,
} from "./plugin-state-worker-errors.js";

type Scope = Pick<SqliteWorkerStore<PluginStateWorkerOperations>, "execute">;
type Input<Key extends keyof PluginStateWorkerOperations> =
  PluginStateWorkerOperations[Key]["input"] & { env?: NodeJS.ProcessEnv };

async function execute<T>(
  env: NodeJS.ProcessEnv | undefined,
  name: keyof PluginStateWorkerOperations,
  dispatch: (scope: Scope) => Promise<Result<T, PluginStateWorkerFailure>>,
  missing?: () => T,
): Promise<T> {
  const databasePath = resolveOpenClawStateSqlitePath(env ?? process.env);
  const description = pluginStateWorkerOperations[name];
  let dispatched = false;
  try {
    const context = captureOpenClawStateWorkerContext({ path: databasePath, env });
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    const operation = async (scope: Scope) => {
      dispatched = true;
      const result = await dispatch(scope);
      if (!result.ok) {
        throw restorePluginStateWorkerFailure(result.error);
      }
      return result.value;
    };
    if (missing) {
      const result = await runOpenClawStateWorkerOperation(context, operation, {
        existingOnly: true,
      });
      return result === undefined ? missing() : result;
    }
    return await runOpenClawStateWorkerOperation(context, operation);
  } catch (error) {
    throw wrapPluginStateError(
      error,
      description.operation,
      dispatched ? description.code : "PLUGIN_STATE_OPEN_FAILED",
      dispatched ? description.message : "Failed to open the plugin state database.",
      databasePath,
    );
  }
}

export function registerPluginStateInWorker(params: Input<"pluginState.register">): Promise<void> {
  const { env, ...input } = params;
  return execute(env, "pluginState.register", (scope) =>
    scope.execute({ type: "pluginState.register", input }),
  );
}

export function observePluginStateInWorker(params: Input<"pluginState.observe">) {
  const { env, ...input } = params;
  return execute(env, "pluginState.observe", (scope) =>
    scope.execute({ type: "pluginState.observe", input }),
  );
}

export function comparePluginStateUpdateInWorker(params: Input<"pluginState.compareUpdate">) {
  const { env, ...input } = params;
  return execute(env, "pluginState.compareUpdate", (scope) =>
    scope.execute({ type: "pluginState.compareUpdate", input }),
  );
}

export function comparePluginStateDeleteInWorker(params: Input<"pluginState.compareDelete">) {
  const { env, ...input } = params;
  return execute(env, "pluginState.compareDelete", (scope) =>
    scope.execute({ type: "pluginState.compareDelete", input }),
  );
}

export function registerPluginStateIfAbsentInWorker(
  params: Input<"pluginState.registerIfAbsent">,
): Promise<boolean> {
  const { env, ...input } = params;
  return execute(env, "pluginState.registerIfAbsent", (scope) =>
    scope.execute({ type: "pluginState.registerIfAbsent", input }),
  );
}

export function deletePluginStateIfEqualInWorker(
  params: Input<"pluginState.deleteIfEqual">,
): Promise<boolean> {
  const { env, ...input } = params;
  return execute(env, "pluginState.deleteIfEqual", (scope) =>
    scope.execute({ type: "pluginState.deleteIfEqual", input }),
  );
}

export function lookupPluginStateInWorker(params: Input<"pluginState.lookup">): Promise<unknown> {
  const { env, ...input } = params;
  return execute(
    env,
    "pluginState.lookup",
    (scope) => scope.execute({ type: "pluginState.lookup", input }),
    () => undefined,
  );
}

export async function lookupManyPluginStateInWorker(
  params: Input<"pluginState.lookupMany">,
): Promise<Array<Result<unknown, PluginStateStoreError>>> {
  const { env, ...input } = params;
  if (input.keys.length === 0) {
    return [];
  }
  const results = await execute(
    env,
    "pluginState.lookupMany",
    (scope) => scope.execute({ type: "pluginState.lookupMany", input }),
    () => input.keys.map(() => ok<unknown, PluginStateWorkerFailure>(undefined)),
  );
  return results.map((result) =>
    result.ok ? result : err(restorePluginStateWorkerFailure(result.error)),
  );
}

export function consumePluginStateInWorker(params: Input<"pluginState.consume">): Promise<unknown> {
  const { env, ...input } = params;
  return execute(env, "pluginState.consume", (scope) =>
    scope.execute({ type: "pluginState.consume", input }),
  );
}

export function deletePluginStateInWorker(params: Input<"pluginState.delete">): Promise<boolean> {
  const { env, ...input } = params;
  return execute(env, "pluginState.delete", (scope) =>
    scope.execute({ type: "pluginState.delete", input }),
  );
}

export function listPluginStateInWorker(params: Input<"pluginState.entries">) {
  const { env, ...input } = params;
  return execute(
    env,
    "pluginState.entries",
    (scope) => scope.execute({ type: "pluginState.entries", input }),
    () => [],
  );
}

export function clearPluginStateInWorker(params: Input<"pluginState.clear">): Promise<void> {
  const { env, ...input } = params;
  return execute(env, "pluginState.clear", (scope) =>
    scope.execute({ type: "pluginState.clear", input }),
  );
}

export function countPluginStateInWorker(params: Input<"pluginState.count">): Promise<number> {
  const { env, ...input } = params;
  return execute(
    env,
    "pluginState.count",
    (scope) => scope.execute({ type: "pluginState.count", input }),
    () => 0,
  );
}

export function registerPluginStateJournalInWorker(params: Input<"pluginState.appendJournal">) {
  const { env, ...input } = params;
  return execute(env, "pluginState.appendJournal", (scope) =>
    scope.execute({ type: "pluginState.appendJournal", input }),
  );
}

export function listPluginStateInKeyRangeInWorker(params: Input<"pluginState.entriesInKeyRange">) {
  const { env, ...input } = params;
  return execute(
    env,
    "pluginState.entriesInKeyRange",
    (scope) => scope.execute({ type: "pluginState.entriesInKeyRange", input }),
    () => [],
  );
}
