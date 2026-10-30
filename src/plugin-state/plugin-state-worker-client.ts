import { toUSVString } from "node:util";
import { serialize } from "node:v8";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { assertSessionEntriesCurrentAdmission } from "../config/sessions/session-entry-current-admission.js";
import type {
  SessionEntryCurrentCheck,
  SessionEntriesCurrentCheck,
} from "../config/sessions/session-entry-current.types.js";
import { assertStateDatabaseReadAllowed } from "../infra/gateway-state-owner.js";
import { hasSqliteDatabaseSchemaAdmissionForIdentity } from "../infra/sqlite-database-admission.js";
import {
  SQLITE_WORKER_MAX_MESSAGE_BYTES,
  type SqliteWorkerCommand,
} from "../infra/sqlite-worker-contract.js";
import type {
  SqliteWorkerAdmissionFactory,
  SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import { isArtifactPreservingStateRead } from "../state/artifact-preserving-state-reads.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { DomainScope } from "../state/openclaw-state-worker-store.types.js";
import {
  canRejectResidentPluginStateClaim,
  ensurePluginStateNamespace,
  listResidentPluginStateEntries,
  livePluginStateRow,
  PLUGIN_STATE_RESIDENT_NAMESPACES,
  readCommittedPluginStateNamespace,
  readPluginStateNamespace,
} from "./plugin-state-namespace-owner.js";
import {
  createPluginStateObservation,
  pluginStateComparisonScope,
} from "./plugin-state-observation.js";
import type {
  PluginStateOperationCommit,
  PluginStateOperationResult,
} from "./plugin-state-operation-contract.js";
import {
  beginPluginStateMutation,
  capturePluginStateMutationSettlement,
} from "./plugin-state-operation-epochs.js";
import {
  beginPluginStatePublication,
  recordPluginStateReadDependency,
  withPluginStatePublication,
  type PluginStatePublicationEffect,
  type PluginStatePublicationScope,
} from "./plugin-state-publication.js";
import { preparePluginStateReceiptInput } from "./plugin-state-receipt-input.js";
import { wrapPluginStateError } from "./plugin-state-store.database.js";
import {
  assertPluginStateKey,
  isRetainedPluginStateNamespace,
  type PluginStateReadRow,
} from "./plugin-state-store.kernel.js";
import { decodePluginStateLookups } from "./plugin-state-store.reads.js";
import { PluginStateStoreError } from "./plugin-state-store.types.js";
import {
  pluginStateWorkerOperations,
  isPluginStateReadCommand,
  type PluginStateWorkerOperations,
  type PluginStateWorkerRequests,
} from "./plugin-state-worker-contract.js";
import {
  capturePluginStateWorkerFailure,
  restorePluginStateWorkerFailure,
  type PluginStateWorkerFailure,
} from "./plugin-state-worker-errors.js";
import { selectRuntimeHealthClearKeys } from "./runtime-health-records.js";

type HostAdmission = {
  context?: OpenClawStateWorkerContext;
  env?: NodeJS.ProcessEnv;
  assertActive?: () => void;
  assertCurrent?: () => void;
  signal?: AbortSignal;
  sessionEntryCurrent?: SessionEntryCurrentCheck | SessionEntriesCurrentCheck;
};
type Input<Key extends keyof PluginStateWorkerOperations> =
  PluginStateWorkerOperations[Key]["input"] & HostAdmission;
type ObservationCheck<Key extends keyof PluginStateWorkerOperations> = (
  result: PluginStateWorkerRequests[Key]["output"],
) => boolean;
type ReadDependency = { pluginId: string; namespace: string; keys: readonly string[] };

type PluginStateCommandOrder = { ready: Promise<void> | undefined; finish?: () => void };
type PluginStateCommand = SqliteWorkerCommand<PluginStateWorkerOperations>;

function publicationScope(command: PluginStateCommand): PluginStatePublicationScope | undefined {
  switch (command.type) {
    case "pluginState.register":
    case "pluginState.registerIfAbsent":
    case "pluginState.replaceEntry":
    case "pluginState.compareUpdate": {
      const { pluginId, namespace, key, overflowPolicy } = command.input;
      // These policies cannot evict another live key; readers already filter expiry.
      return {
        pluginId,
        namespace,
        ...(overflowPolicy === "reject-new" || isRetainedPluginStateNamespace(namespace)
          ? { key }
          : {}),
      };
    }
    case "pluginState.observe":
    case "pluginState.consume":
    case "pluginState.delete":
    case "pluginState.deleteIfEqual":
    case "pluginState.compareDelete": {
      const { pluginId, namespace, key } = command.input;
      return { pluginId, namespace, key };
    }
    case "pluginState.replace":
    case "pluginState.clear":
    case "pluginState.clearRuntimeHealth": {
      const { pluginId, namespace } = command.input;
      return { pluginId, namespace };
    }
    default:
      // Compound operations retain database-wide denial without an exact write scope.
      return undefined;
  }
}

function prepareCommandOrder(
  coordinationKey: string,
  command: PluginStateCommand,
): PluginStateCommandOrder | undefined {
  switch (command.type) {
    case "pluginState.executeOperation":
      return undefined;
    case "pluginState.loadNamespace":
    case "pluginState.lookup":
    case "pluginState.lookupMany":
    case "pluginState.entries":
    case "pluginState.entriesInKeyRange":
    case "pluginState.count":
    case "pluginState.observe":
      return { ready: capturePluginStateMutationSettlement(coordinationKey, [command.input]) };
    case "pluginState.appendJournal":
      return beginPluginStateMutation(coordinationKey, [
        { pluginId: command.input.pluginId, namespace: command.input.cursorNamespace },
        { pluginId: command.input.pluginId, namespace: command.input.journalNamespace },
      ]);
    case "pluginState.moveEntries":
      return beginPluginStateMutation(coordinationKey, [
        command.input,
        { ...command.input, namespace: command.input.sourceNamespace },
      ]);
    default:
      return beginPluginStateMutation(coordinationKey, [command.input]);
  }
}

function publicationEffect(
  command: PluginStateCommand,
  scope: PluginStatePublicationScope | undefined,
): PluginStatePublicationEffect | undefined {
  if (command.type === "pluginState.observe") {
    return Object.freeze({ kind: "unchanged" });
  }
  // Only exact-key CAS writes have a bounded set of possible values: the
  // committed row on conflict/rollback, or this immutable serialized postimage.
  if (command.type === "pluginState.compareUpdate" && scope?.key !== undefined) {
    if (command.input.action === "keep") {
      return Object.freeze({ kind: "unchanged" });
    }
    if (command.input.ttlMs === undefined) {
      return Object.freeze({ kind: "postimage", valueJson: command.input.valueJson });
    }
  }
  return undefined;
}

async function execute<Key extends keyof PluginStateWorkerOperations>(
  { env, assertActive, sessionEntryCurrent, context: capturedContext, signal }: HostAdmission,
  command: { type: Key; input: PluginStateWorkerOperations[Key]["input"] },
  missing?: () => PluginStateWorkerRequests[Key]["output"],
  checks: {
    assertCurrent?: () => void;
    isObservation?: ObservationCheck<Key>;
    existingOnly?: { missing: () => PluginStateWorkerRequests[Key]["output"] };
    readDependency?: ReadDependency;
    onCommitted?: (facts: unknown) => void;
    preparedEmptyShortcut?: boolean;
  } = {},
): Promise<PluginStateWorkerRequests[Key]["output"]> {
  const { assertCurrent, isObservation, existingOnly, onCommitted } = checks;
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
  const databasePath =
    capturedContext?.admission.databasePath ?? resolveOpenClawStateSqlitePath(env ?? process.env);
  const description = pluginStateWorkerOperations[command.type];
  let operationStarted = false;
  let order: PluginStateCommandOrder | undefined;
  let publication: ReturnType<typeof beginPluginStatePublication> | undefined;
  try {
    const context =
      capturedContext ?? captureOpenClawStateWorkerContext({ path: databasePath, env });
    if (checks.readDependency) {
      const identity = context.admission.identity.key;
      recordPluginStateReadDependency({
        ...checks.readDependency,
        identity: identity.startsWith("file:") ? identity : undefined,
        assertCurrent: context.admission.assertCurrent,
      });
    }
    // SAFETY: Key and input are correlated by every caller; this forms the dispatch union.
    const typedCommand = command as PluginStateCommand;
    const writeScope = publicationScope(typedCommand);
    const effect = publicationEffect(typedCommand, writeScope);
    order = prepareCommandOrder(context.admission.coordinationKey, typedCommand);
    if (
      order?.finish ||
      (typedCommand.type === "pluginState.executeOperation" &&
        typedCommand.input.writeStores.length > 0)
    ) {
      publication = beginPluginStatePublication(
        () => context.admission.identity.key,
        context.assertPublicationCurrent ?? context.admission.assertCurrent,
        writeScope,
        effect,
      );
    }
    if (order?.ready) {
      await order.ready;
      assertAdmission?.();
    }
    const readOperation =
      typedCommand.type === "pluginState.executeOperation" &&
      typedCommand.input.writeStores.length === 0;
    if (
      !currentEntries &&
      !isArtifactPreservingStateRead("shared", databasePath) &&
      (readOperation ||
        typedCommand.type === "pluginState.observe" ||
        typedCommand.type === "pluginState.lookup" ||
        typedCommand.type === "pluginState.lookupMany" ||
        typedCommand.type === "pluginState.entries" ||
        typedCommand.type === "pluginState.count" ||
        (typedCommand.type === "pluginState.registerIfAbsent" &&
          readCommittedPluginStateNamespace(context.admission.identity.key, typedCommand.input)) ||
        (typedCommand.type === "pluginState.entriesInKeyRange" &&
          !typedCommand.input.valueFilter) ||
        typedCommand.type === "pluginState.clearRuntimeHealth")
    ) {
      const terminalFailure =
        openClawStateDatabaseCache.getOpenClawStateDatabaseRecordedFailure(databasePath);
      if (terminalFailure) {
        throw terminalFailure;
      }
      operationStarted = true;
      context.admission.assertCurrent();
      assertStateDatabaseReadAllowed(databasePath);
      operationStarted = false;
      const identity = context.admission.identity.key;
      const scopes =
        typedCommand.type === "pluginState.executeOperation"
          ? [
              ...new Map(
                typedCommand.input.stores.map((scope) => [
                  JSON.stringify([scope.pluginId, scope.namespace]),
                  scope,
                ]),
              ).values(),
            ]
          : [typedCommand.input];
      if (scopes.length <= PLUGIN_STATE_RESIDENT_NAMESPACES) {
        for (const scope of scopes) {
          const loading = ensurePluginStateNamespace(identity, scope, async (maxBytes) => {
            const loader = pluginStateWorkerOperations["pluginState.loadNamespace"];
            const { runOpenClawStateWorkerOperation } =
              await import("../state/openclaw-state-worker-store.js");
            try {
              const result = await runOpenClawStateWorkerOperation(
                context,
                (worker) =>
                  worker.execute({
                    type: "pluginState.loadNamespace",
                    input: { ...scope, maxBytes },
                  }),
                { signal, existingOnly: true },
              );
              if (result && !result.ok) {
                throw restorePluginStateWorkerFailure(result.error);
              }
              return result?.value;
            } catch (error) {
              throw wrapPluginStateError(
                error,
                loader.operation,
                "PLUGIN_STATE_OPEN_FAILED",
                "Failed to open the plugin state database.",
                databasePath,
              );
            }
          });
          if (loading) {
            try {
              await loading;
            } catch (error) {
              // A shared load belongs to each caller's public operation, not its first reader.
              if (
                error instanceof PluginStateStoreError &&
                (error.code === "PLUGIN_STATE_READ_FAILED" ||
                  error.code === "PLUGIN_STATE_OPEN_FAILED")
              ) {
                throw new PluginStateStoreError(
                  error.code === "PLUGIN_STATE_READ_FAILED" ? description.message : error.message,
                  {
                    code: error.code === "PLUGIN_STATE_READ_FAILED" ? description.code : error.code,
                    operation: description.operation,
                    path: error.path,
                    cause: error.cause,
                    owner: error.owner,
                  },
                );
              }
              throw error;
            }
            operationStarted = true;
            assertAdmission?.();
          }
        }
        // Capture all namespaces without yielding. A fallback never mixes resident and SQL views.
        const rows = scopes.map((scope) =>
          typedCommand.type === "pluginState.clearRuntimeHealth" ||
          typedCommand.type === "pluginState.registerIfAbsent"
            ? readCommittedPluginStateNamespace(identity, scope)
            : readPluginStateNamespace(identity, scope),
        );
        if (
          rows.every((view) => view !== undefined) &&
          hasSqliteDatabaseSchemaAdmissionForIdentity(context.admission.identity)
        ) {
          operationStarted = true;
          context.admission.assertCurrent();
          assertStateDatabaseReadAllowed(databasePath);
          assertAdmission?.();
          const view = rows[0]!;
          const postgres = context.databaseEngineSelection?.effectiveEngines.state === "postgres";
          switch (typedCommand.type) {
            case "pluginState.registerIfAbsent":
              if (
                canRejectResidentPluginStateClaim(view, typedCommand.input, databasePath, postgres)
              ) {
                // SAFETY: Earlier writes settled above; an occupied claim returns false unchanged.
                return false as PluginStateWorkerRequests[Key]["output"];
              }
              break;
            case "pluginState.executeOperation": {
              const snapshots: Record<string, readonly PluginStateReadRow[]> = {};
              for (const [index, scope] of scopes.entries()) {
                snapshots[JSON.stringify([scope.pluginId, scope.namespace])] = [
                  ...rows[index]!.values(),
                ];
              }
              const input = { ...typedCommand.input, namespaceSnapshots: snapshots };
              if (serialize(input).byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES) {
                typedCommand.input = input;
                const shortcut = input.ifEmpty;
                if (shortcut && checks.preparedEmptyShortcut) {
                  const scope = input.stores[shortcut.store]!;
                  const empty = snapshots[JSON.stringify([scope.pluginId, scope.namespace])]!.every(
                    (row) => !livePluginStateRow(row),
                  );
                  if (empty) {
                    const result = {
                      value: structuredClone(shortcut.value),
                      validUntil: undefined,
                      emptyShortcut: true,
                    };
                    // SAFETY: A prepared read-only operation owns this shortcut result.
                    return result as PluginStateWorkerRequests[Key]["output"];
                  }
                }
              }
              break;
            }
            case "pluginState.clearRuntimeHealth":
              if (
                selectRuntimeHealthClearKeys(
                  listResidentPluginStateEntries(view, databasePath),
                  typedCommand.input.processId,
                  typedCommand.input.selection,
                ).length === 0
              ) {
                // SAFETY: The resident view proves this selected clear has no effect.
                return undefined as PluginStateWorkerRequests[Key]["output"];
              }
              break;
            case "pluginState.entries":
            case "pluginState.entriesInKeyRange": {
              const range =
                typedCommand.type === "pluginState.entriesInKeyRange"
                  ? typedCommand.input
                  : undefined;
              if (range) {
                assertPluginStateKey(postgres, range.keyStartInclusive, "entries");
                assertPluginStateKey(postgres, range.keyEndExclusive, "entries");
              }
              const entries = listResidentPluginStateEntries(view, databasePath, range);
              // SAFETY: Both enumeration commands return the same entry envelope.
              return entries as PluginStateWorkerRequests[Key]["output"];
            }
            case "pluginState.count": {
              const now = Date.now();
              const count = [...view.values()].filter((row) => livePluginStateRow(row, now)).length;
              // SAFETY: The count command returns the live row count without JSON decoding.
              return count as PluginStateWorkerRequests[Key]["output"];
            }
            case "pluginState.observe": {
              assertPluginStateKey(postgres, typedCommand.input.key, "lookup");
              const row = livePluginStateRow(view.get(toUSVString(typedCommand.input.key)));
              const observation = {
                ...createPluginStateObservation(
                  databasePath,
                  pluginStateComparisonScope(identity, typedCommand.input),
                  row,
                  "lookup",
                ),
                row,
              };
              // SAFETY: The observe command returns this private raw-row envelope.
              return observation as PluginStateWorkerRequests[Key]["output"];
            }
            case "pluginState.lookup":
            case "pluginState.lookupMany": {
              const keys =
                typedCommand.type === "pluginState.lookupMany"
                  ? typedCommand.input.keys
                  : [typedCommand.input.key];
              for (const key of keys) {
                assertPluginStateKey(postgres, key, "lookup");
              }
              const now = Date.now();
              const values = decodePluginStateLookups(
                keys,
                (key) => livePluginStateRow(view.get(key), now)?.value_json,
                databasePath,
              );
              if (typedCommand.type === "pluginState.lookupMany") {
                const results = values.map((value) =>
                  value.ok ? value : err(capturePluginStateWorkerFailure(value.error)),
                );
                // SAFETY: Each slot preserves the lookupMany wire error/result contract.
                return results as PluginStateWorkerRequests[Key]["output"];
              }
              const value = values[0]!;
              if (!value.ok) {
                throw value.error;
              }
              // SAFETY: The remaining command is a single decoded lookup.
              return value.value as PluginStateWorkerRequests[Key]["output"];
            }
          }
        }
      }
    }
    if (isPluginStateReadCommand(typedCommand)) {
      const reply = await executeExistingOpenClawStateRead(
        { path: databasePath, env },
        typedCommand,
        {
          context,
          signal,
          current: true,
          preferIndependentWarmRead: true,
          mapError(error, phase) {
            operationStarted = phase === "read";
            return error;
          },
        },
      );
      assertAdmission?.();
      if (!reply) {
        return missing!();
      }
      operationStarted = true;
      if (!reply.result.ok) {
        throw restorePluginStateWorkerFailure(reply.result.error);
      }
      // SAFETY: The reader preserves the command's typed result, as the writer transport does.
      return reply.result.value as PluginStateWorkerRequests[Key]["output"];
    }
    // A write-only await here would let later reads overtake it before broker admission.
    const [
      { runOpenClawStateWorkerOperation },
      { createSqliteWorkerWriteAdmission },
      { createSqliteWorkerOperationAdmission },
    ] = await Promise.all([
      import("../state/openclaw-state-worker-store.js"),
      import("../infra/sqlite-worker-store.js"),
      import("../infra/sqlite-worker-operation-admission.js"),
    ]);
    const operation = async (scope: DomainScope) => {
      operationStarted = true;
      const result = await scope.execute({
        type: typedCommand.type,
        input: {
          ...typedCommand.input,
          sessionEntryCurrentSources: currentEntries?.sources,
        },
      });
      if (!result.ok) {
        throw restorePluginStateWorkerFailure(result.error);
      }
      // SAFETY: Dispatch preserves the caller's command/result pairing across the writer transport.
      return result.value as PluginStateWorkerRequests[Key]["output"];
    };
    if (missing) {
      const result = await runOpenClawStateWorkerOperation(context, operation, {
        signal,
        existingOnly: true,
        assertCurrent: assertAdmission,
      });
      assertActive?.();
      return result === undefined ? missing() : result;
    }
    const assertWriteCurrent = (request: SqliteWorkerAdmissionRequest) => {
      context.admission.assertCurrent();
      assertAdmission?.();
      assertSessionEntriesCurrentAdmission(request, currentEntries);
    };
    const baseAdmission: SqliteWorkerAdmissionFactory =
      command.type === "pluginState.replaceEntry"
        ? () => {
            // Revocation commits before replacement; both transactions require fresh grants.
            const stages = ["transaction", "commit", "transaction", "commit"] as const;
            let next = 0;
            return {
              nativeLocations: [databasePath],
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                if (request.stage !== stages[next]) {
                  throw new Error("Plugin state replacement authority requested out of order");
                }
                assertWriteCurrent(request);
                if (!grant()) {
                  throw new Error("Plugin state replacement authority expired");
                }
                next += 1;
              }),
            };
          }
        : createSqliteWorkerWriteAdmission(assertWriteCurrent, [databasePath]);
    // Writable operations, including comparison observations, must share the
    // host lifecycle owner before dispatch so sibling maintenance cannot overtake them.
    const result = await runOpenClawStateWorkerOperation(context, operation, {
      signal,
      assertCurrent: assertAdmission,
      createAdmission: withPluginStatePublication(
        baseAdmission,
        context,
        preparePluginStateReceiptInput(typedCommand),
        onCommitted,
        writeScope,
        effect,
      ),
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
      operationStarted ? description.code : "PLUGIN_STATE_OPEN_FAILED",
      operationStarted ? description.message : "Failed to open the plugin state database.",
      databasePath,
    );
  } finally {
    try {
      publication?.finish("completed");
    } finally {
      order?.finish?.();
    }
  }
}

export function executePluginStateOperationInWorker(
  params: Input<"pluginState.executeOperation">,
  options: {
    missing?: () => PluginStateOperationResult;
    preparedEmptyShortcut?: boolean;
    onCommitted: (facts: PluginStateOperationCommit["pluginStateOperation"]) => void;
  },
): Promise<PluginStateOperationResult> {
  const { env, assertActive, assertCurrent, sessionEntryCurrent, context, ...input } = params;
  return execute(
    { env, assertActive, sessionEntryCurrent, context },
    { type: "pluginState.executeOperation", input },
    input.writeStores.length === 0
      ? (options.missing ??
          (() => {
            throw new Error("Plugin state operation source does not exist");
          }))
      : undefined,
    {
      assertCurrent,
      preparedEmptyShortcut: options.preparedEmptyShortcut,
      onCommitted(facts) {
        // SAFETY: This admission belongs to the host-minted plugin state command and receipt shape.
        options.onCommitted((facts as PluginStateOperationCommit).pluginStateOperation);
      },
    },
  );
}

function createOperation<Key extends keyof PluginStateWorkerOperations>(
  type: Key,
  missing?: () => PluginStateWorkerRequests[Key]["output"],
  isObservation?: ObservationCheck<Key>,
  readDependency?: (params: Input<Key>) => ReadDependency,
) {
  return (params: Input<Key>): Promise<PluginStateWorkerRequests[Key]["output"]> => {
    // Host authority stays in the broker admission; only data crosses to the worker.
    const input = { ...params };
    const { env, assertActive, assertCurrent, sessionEntryCurrent, context, signal } = input;
    delete input.context;
    delete input.env;
    delete input.assertActive;
    delete input.assertCurrent;
    delete input.sessionEntryCurrent;
    delete input.signal;
    return execute(
      { env, assertActive, sessionEntryCurrent, context, signal },
      { type, input },
      missing,
      {
        assertCurrent,
        isObservation,
        readDependency: readDependency?.(params),
      },
    );
  };
}

export const registerPluginStateInWorker = createOperation("pluginState.register");
export const replacePluginStateInWorker = createOperation("pluginState.replace");
export const replacePluginStateEntryInWorker = createOperation("pluginState.replaceEntry");

export const observePluginStateRowInWorker = createOperation(
  "pluginState.observe",
  undefined,
  () => true,
  ({ pluginId, namespace, key }) => ({ pluginId, namespace, keys: [key] }),
);
export async function observePluginStateInWorker(params: Input<"pluginState.observe">) {
  const { value, comparison } = await observePluginStateRowInWorker(params);
  return { value, comparison };
}
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
export const lookupPluginStateInWorker = createOperation(
  "pluginState.lookup",
  () => undefined,
  undefined,
  ({ pluginId, namespace, key }) => ({ pluginId, namespace, keys: [key] }),
);

export async function lookupManyPluginStateInWorker(
  params: Input<"pluginState.lookupMany">,
): Promise<Array<Result<unknown, PluginStateStoreError>>> {
  const { env, assertActive, sessionEntryCurrent, context, signal, ...input } = params;
  params.assertActive?.();
  if (input.keys.length === 0) {
    return [];
  }
  const results = await execute(
    { env, assertActive, sessionEntryCurrent, context, signal },
    { type: "pluginState.lookupMany", input },
    () => input.keys.map(() => ok<unknown, PluginStateWorkerFailure>(undefined)),
    { readDependency: { pluginId: input.pluginId, namespace: input.namespace, keys: input.keys } },
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
  const { env, assertActive, assertCurrent, sessionEntryCurrent, context, signal, ...input } =
    params;
  return execute(
    { env, assertActive, sessionEntryCurrent, context, signal },
    { type: "pluginState.clearRuntimeHealth", input },
    undefined,
    { assertCurrent, existingOnly: { missing: () => undefined } },
  );
}

export const countPluginStateInWorker = createOperation("pluginState.count", () => 0);
export const registerPluginStateJournalInWorker = createOperation("pluginState.appendJournal");
export const listPluginStateInKeyRangeInWorker = createOperation(
  "pluginState.entriesInKeyRange",
  () => [],
);
export const movePluginStateEntriesInWorker = createOperation("pluginState.moveEntries");
