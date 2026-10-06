import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { assertSessionEntriesCurrentAdmission } from "../config/sessions/session-entry-current-admission.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntriesCurrentCheck,
} from "../config/sessions/session-entry-current.types.js";
import type { SqliteWorkerStore } from "../infra/sqlite-worker-contract.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { wrapPluginStateError } from "./plugin-state-store.database.js";
import type { PluginStateStoreError } from "./plugin-state-store.types.js";
import {
  pluginStateWorkerOperations,
  type PluginStateWorkerOperations,
  type PluginStateWorkerRequests,
} from "./plugin-state-worker-contract.js";
import {
  restorePluginStateWorkerFailure,
  type PluginStateWorkerFailure,
} from "./plugin-state-worker-errors.js";

type Scope = Pick<SqliteWorkerStore<PluginStateWorkerOperations>, "execute">;
type HostAdmission = {
  env?: NodeJS.ProcessEnv;
  assertActive?: () => void;
  assertCurrent?: () => void;
  sessionEntryCurrent?: SessionEntryCurrentCheck | SessionEntriesCurrentCheck;
};
type Input<Key extends keyof PluginStateWorkerOperations> =
  PluginStateWorkerOperations[Key]["input"] & HostAdmission;
type ObservationCheck<Key extends keyof PluginStateWorkerOperations> = (
  result: PluginStateWorkerRequests[Key]["output"],
) => boolean;

async function execute<Key extends keyof PluginStateWorkerOperations>(
  { env, assertActive, sessionEntryCurrent }: HostAdmission,
  command: { type: Key; input: PluginStateWorkerOperations[Key]["input"] },
  missing?: () => PluginStateWorkerRequests[Key]["output"],
  checks: {
    assertCurrent?: () => void;
    isObservation?: ObservationCheck<Key>;
    existingOnly?: { missing: () => PluginStateWorkerRequests[Key]["output"] };
  } = {},
): Promise<PluginStateWorkerRequests[Key]["output"]> {
  const { assertCurrent, isObservation, existingOnly } = checks;
  const currentEntries: SessionEntriesCurrentCheck | undefined =
    sessionEntryCurrent && "source" in sessionEntryCurrent
      ? {
          sources: [sessionEntryCurrent.source],
          assertCurrent: ([entry]) => sessionEntryCurrent.assertCurrent(entry),
        }
      : sessionEntryCurrent;
  const assertAdmission = assertCurrent
    ? () => {
        assertActive?.();
        assertCurrent();
      }
    : assertActive;
  assertAdmission?.();
  const databasePath = resolveOpenClawStateSqlitePath(env ?? process.env);
  const description = pluginStateWorkerOperations[command.type];
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
      const result = await scope.execute<Key>(
        command.input === undefined
          ? command
          : {
              type: command.type,
              input: {
                ...command.input,
                sessionEntryCurrentSources: currentEntries?.sources,
              },
            },
      );
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
    const createAdmission = createSqliteWorkerWriteAdmission(
      (request) => {
        context.admission.assertCurrent();
        assertAdmission?.();
        assertSessionEntriesCurrentAdmission(request, currentEntries);
      },
      [databasePath],
    );
    // Writable operations, including comparison observations, must share the
    // host lifecycle owner before dispatch so sibling maintenance cannot overtake them.
    const result = await runOpenClawStateWorkerOperation(context, operation, {
      assertCurrent: assertAdmission,
      createAdmission,
      existingOnly: existingOnly !== undefined,
    });
    if (result === undefined && existingOnly) {
      return existingOnly.missing();
    }
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

function createOperation<
  Key extends Exclude<keyof PluginStateWorkerOperations, "pluginState.sweep">,
>(
  type: Key,
  missing?: () => PluginStateWorkerRequests[Key]["output"],
  isObservation?: ObservationCheck<Key>,
) {
  return (params: Input<Key>): Promise<PluginStateWorkerRequests[Key]["output"]> => {
    // Host authority stays in the broker admission; only data crosses to the worker.
    const input = { ...params };
    const { env, assertActive, assertCurrent, sessionEntryCurrent } = input;
    delete input.env;
    delete input.assertActive;
    delete input.assertCurrent;
    delete input.sessionEntryCurrent;
    return execute({ env, assertActive, sessionEntryCurrent }, { type, input }, missing, {
      assertCurrent,
      isObservation,
    });
  };
}

export const registerPluginStateInWorker = createOperation("pluginState.register");

export const observePluginStateInWorker = createOperation(
  "pluginState.observe",
  undefined,
  () => true,
);
export const comparePluginStateUpdateInWorker = createOperation(
  "pluginState.compareUpdate",
  undefined,
  (result) => result.status === "conflict",
);
export const comparePluginStateDeleteInWorker = createOperation(
  "pluginState.compareDelete",
  undefined,
  (result) => result.status === "conflict",
);
export const registerPluginStateIfAbsentInWorker = createOperation("pluginState.registerIfAbsent");
export const deletePluginStateIfEqualInWorker = createOperation("pluginState.deleteIfEqual");
export const lookupPluginStateInWorker = createOperation("pluginState.lookup", () => undefined);

export async function lookupManyPluginStateInWorker(
  params: Input<"pluginState.lookupMany">,
): Promise<Array<Result<unknown, PluginStateStoreError>>> {
  const { env, assertActive, sessionEntryCurrent, ...input } = params;
  params.assertActive?.();
  if (input.keys.length === 0) {
    return [];
  }
  const results = await execute(
    { env, assertActive, sessionEntryCurrent },
    { type: "pluginState.lookupMany", input },
    () => input.keys.map(() => ok<unknown, PluginStateWorkerFailure>(undefined)),
  );
  return results.map((result) =>
    result.ok ? result : err(restorePluginStateWorkerFailure(result.error)),
  );
}

export const consumePluginStateInWorker = createOperation("pluginState.consume");

export const deletePluginStateInWorker = createOperation("pluginState.delete");

export const listPluginStateInWorker = createOperation("pluginState.entries", () => []);
export const clearPluginStateInWorker = createOperation("pluginState.clear");

export function clearRuntimeHealthInWorker(
  params: Input<"pluginState.clearRuntimeHealth"> & { assertCurrent?: () => void },
): Promise<void> {
  const { env, assertActive, assertCurrent, sessionEntryCurrent, ...input } = params;
  return execute(
    { env, assertActive, sessionEntryCurrent },
    { type: "pluginState.clearRuntimeHealth", input },
    undefined,
    { assertCurrent, existingOnly: { missing: () => undefined } },
  );
}

export function sweepExpiredPluginStateEntriesInWorker(
  params: HostAdmission = {},
): Promise<number> {
  return execute(params, { type: "pluginState.sweep", input: undefined });
}

export const countPluginStateInWorker = createOperation("pluginState.count", () => 0);
export const registerPluginStateJournalInWorker = createOperation("pluginState.appendJournal");
export const listPluginStateInKeyRangeInWorker = createOperation(
  "pluginState.entriesInKeyRange",
  () => [],
);
export const movePluginStateEntriesInWorker = createOperation("pluginState.moveEntries");
