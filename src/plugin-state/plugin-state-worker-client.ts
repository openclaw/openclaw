import { err, ok, type Result } from "@openclaw/normalization-core/result";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { wrapPluginStateError } from "./plugin-state-store.database.js";
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
type HostAdmission = { env?: NodeJS.ProcessEnv; assertActive?: () => void };
type Input<Key extends keyof PluginStateWorkerOperations> =
  PluginStateWorkerOperations[Key]["input"] & HostAdmission;

async function execute<T>(
  { env, assertActive }: HostAdmission,
  name: keyof PluginStateWorkerOperations,
  dispatch: (scope: Scope) => Promise<Result<T, PluginStateWorkerFailure>>,
  missing?: () => T,
  checks: { assertCurrent?: () => void; isObservation?: (result: T) => boolean } = {},
): Promise<T> {
  const { assertCurrent, isObservation } = checks;
  const assertAdmission = assertCurrent
    ? () => {
        assertActive?.();
        assertCurrent();
      }
    : assertActive;
  assertAdmission?.();
  const databasePath = resolveOpenClawStateSqlitePath(env ?? process.env);
  const description = pluginStateWorkerOperations[name];
  let dispatched = false;
  try {
    const context = captureOpenClawStateWorkerContext({ path: databasePath, env });
    // A write-only await here would let later reads overtake it before broker admission.
    const [{ runOpenClawStateWorkerOperation }, { createSqliteWorkerWriteAdmission }] =
      await Promise.all([
        import("../state/openclaw-state-worker-store.js"),
        import("../infra/sqlite-worker-store.js"),
      ]);
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
        assertCurrent: assertAdmission,
      });
      assertActive?.();
      return result === undefined ? missing() : result;
    }
    const createAdmission = createSqliteWorkerWriteAdmission(() => {
      context.admission.assertCurrent();
      assertAdmission?.();
    }, [databasePath]);
    // Writable operations, including comparison observations, must share the
    // host lifecycle owner before dispatch so sibling maintenance cannot overtake them.
    const result = await runOpenClawStateWorkerOperation(context, operation, {
      assertCurrent: assertAdmission,
      requireStateLifecycle: true,
      createAdmission,
    });
    if (isObservation?.(result)) {
      assertAdmission?.();
    }
    return result;
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

export function registerPluginStateInWorker(
  params: Input<"pluginState.register"> & { assertCurrent?: () => void },
): Promise<void> {
  const { env, assertActive, assertCurrent, ...input } = params;
  return execute(
    { env, assertActive },
    "pluginState.register",
    (scope) => scope.execute({ type: "pluginState.register", input }),
    undefined,
    { assertCurrent },
  );
}

export function observePluginStateInWorker(params: Input<"pluginState.observe">) {
  const { env, assertActive, ...input } = params;
  return execute(
    { env, assertActive },
    "pluginState.observe",
    (scope) => scope.execute({ type: "pluginState.observe", input }),
    undefined,
    { isObservation: () => true },
  );
}

export function comparePluginStateUpdateInWorker(params: Input<"pluginState.compareUpdate">) {
  const { env, assertActive, ...input } = params;
  return execute(
    { env, assertActive },
    "pluginState.compareUpdate",
    (scope) => scope.execute({ type: "pluginState.compareUpdate", input }),
    undefined,
    { isObservation: (result) => result.status === "conflict" },
  );
}

export function comparePluginStateDeleteInWorker(params: Input<"pluginState.compareDelete">) {
  const { env, assertActive, ...input } = params;
  return execute(
    { env, assertActive },
    "pluginState.compareDelete",
    (scope) => scope.execute({ type: "pluginState.compareDelete", input }),
    undefined,
    { isObservation: (result) => result.status === "conflict" },
  );
}

export function registerPluginStateIfAbsentInWorker(
  params: Input<"pluginState.registerIfAbsent">,
): Promise<boolean> {
  const { env, assertActive, ...input } = params;
  return execute({ env, assertActive }, "pluginState.registerIfAbsent", (scope) =>
    scope.execute({ type: "pluginState.registerIfAbsent", input }),
  );
}

export function deletePluginStateIfEqualInWorker(
  params: Input<"pluginState.deleteIfEqual">,
): Promise<boolean> {
  const { env, assertActive, ...input } = params;
  return execute({ env, assertActive }, "pluginState.deleteIfEqual", (scope) =>
    scope.execute({ type: "pluginState.deleteIfEqual", input }),
  );
}

export function lookupPluginStateInWorker(params: Input<"pluginState.lookup">): Promise<unknown> {
  const { env, assertActive, ...input } = params;
  return execute(
    { env, assertActive },
    "pluginState.lookup",
    (scope) => scope.execute({ type: "pluginState.lookup", input }),
    () => undefined,
  );
}

export async function lookupManyPluginStateInWorker(
  params: Input<"pluginState.lookupMany">,
): Promise<Array<Result<unknown, PluginStateStoreError>>> {
  const { env, assertActive, ...input } = params;
  params.assertActive?.();
  if (input.keys.length === 0) {
    return [];
  }
  const results = await execute(
    { env, assertActive },
    "pluginState.lookupMany",
    (scope) => scope.execute({ type: "pluginState.lookupMany", input }),
    () => input.keys.map(() => ok<unknown, PluginStateWorkerFailure>(undefined)),
  );
  return results.map((result) =>
    result.ok ? result : err(restorePluginStateWorkerFailure(result.error)),
  );
}

export function consumePluginStateInWorker(params: Input<"pluginState.consume">): Promise<unknown> {
  const { env, assertActive, ...input } = params;
  return execute({ env, assertActive }, "pluginState.consume", (scope) =>
    scope.execute({ type: "pluginState.consume", input }),
  );
}

export function deletePluginStateInWorker(
  params: Input<"pluginState.delete"> & { assertCurrent?: () => void },
): Promise<boolean> {
  const { env, assertActive, assertCurrent, ...input } = params;
  return execute(
    { env, assertActive },
    "pluginState.delete",
    (scope) => scope.execute({ type: "pluginState.delete", input }),
    undefined,
    { assertCurrent },
  );
}

export function listPluginStateInWorker(params: Input<"pluginState.entries">) {
  const { env, assertActive, ...input } = params;
  return execute(
    { env, assertActive },
    "pluginState.entries",
    (scope) => scope.execute({ type: "pluginState.entries", input }),
    () => [],
  );
}

export function clearPluginStateInWorker(params: Input<"pluginState.clear">): Promise<void> {
  const { env, assertActive, ...input } = params;
  return execute({ env, assertActive }, "pluginState.clear", (scope) =>
    scope.execute({ type: "pluginState.clear", input }),
  );
}

export function sweepExpiredPluginStateEntriesInWorker(
  params: HostAdmission = {},
): Promise<number> {
  return execute(params, "pluginState.sweep", (scope) =>
    scope.execute({ type: "pluginState.sweep", input: undefined }),
  );
}

export function countPluginStateInWorker(params: Input<"pluginState.count">): Promise<number> {
  const { env, assertActive, ...input } = params;
  return execute(
    { env, assertActive },
    "pluginState.count",
    (scope) => scope.execute({ type: "pluginState.count", input }),
    () => 0,
  );
}

export function registerPluginStateJournalInWorker(params: Input<"pluginState.appendJournal">) {
  const { env, assertActive, ...input } = params;
  return execute({ env, assertActive }, "pluginState.appendJournal", (scope) =>
    scope.execute({ type: "pluginState.appendJournal", input }),
  );
}

export function listPluginStateInKeyRangeInWorker(params: Input<"pluginState.entriesInKeyRange">) {
  const { env, assertActive, ...input } = params;
  return execute(
    { env, assertActive },
    "pluginState.entriesInKeyRange",
    (scope) => scope.execute({ type: "pluginState.entriesInKeyRange", input }),
    () => [],
  );
}

export function movePluginStateEntriesInWorker(params: Input<"pluginState.moveEntries">) {
  const { env, assertActive, ...input } = params;
  return execute({ env, assertActive }, "pluginState.moveEntries", (scope) =>
    scope.execute({ type: "pluginState.moveEntries", input }),
  );
}
