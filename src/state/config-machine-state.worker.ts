import { loadOrCreateConfigRevisionKeyInDatabase } from "../gateway/config-revision-key.worker.js";
import {
  isTerminalPluginReloadOperation,
  MAX_ACTIVE_PLUGIN_RELOAD_OPERATIONS,
  MAX_TERMINAL_PLUGIN_RELOAD_OPERATIONS,
  parsePluginReloadOperation,
  pluginReloadContinuationIdentity,
  PLUGIN_RELOAD_OPERATION_KEY_PREFIX,
  type PluginReloadOperation,
} from "../gateway/plugin-reload-operation-store.types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { sqlPublicationAnchor } from "../infra/sql-connection.js";
import { deferSqliteWorkerCommitReceipt } from "../infra/sqlite-worker-operation-admission.js";
import {
  listConfigMachineStateRowsInDatabase,
  normalizeConfigMachineStateKey,
  type ConfigMachineStateDatabase,
} from "./config-machine-state-row.js";
import { writeConfigMachineStateInDatabase } from "./config-machine-state-write.js";
import { authProfileCredentialPublication } from "./user-model-account-authority.js";
import type { WorkerOperations, WorkerWriteOperationContext } from "./worker-operation-registry.js";

export const machineStateOperations = {
  "machineState.pluginReloadUpsert": (
    input: { operation: PluginReloadOperation },
    context: WorkerWriteOperationContext,
  ) => {
    let operation = parsePluginReloadOperation(input.operation);
    return context.write(
      ({ db }) => {
        const entries = listConfigMachineStateRowsInDatabase(
          db,
          PLUGIN_RELOAD_OPERATION_KEY_PREFIX,
        ).map((row) => {
          const value = parsePluginReloadOperation(JSON.parse(row.value_json));
          if (row.state_key !== PLUGIN_RELOAD_OPERATION_KEY_PREFIX + value.id) {
            throw new Error("Plugin reload operation identity does not match its storage key");
          }
          return value;
        });
        const existing = entries.find((entry) => entry.id === operation.id);
        if (existing) {
          if (
            existing.requestKey &&
            operation.requestKey &&
            existing.requestKey !== operation.requestKey
          ) {
            throw new Error("Plugin reload operation ID belongs to another request");
          }
          const key = pluginReloadContinuationIdentity;
          const continuations = new Map(existing.continuations.map((item) => [key(item), item]));
          for (const item of operation.continuations) {
            const current = continuations.get(key(item));
            // Explicit Stop and settled wake custody are monotonic. A reload phase
            // receipt must not overwrite a concurrent continuation cancellation.
            if (!current || (current.state !== "cancelled" && current.state !== "complete")) {
              continuations.set(key(item), {
                ...item,
                queuedInputIds: [
                  ...new Set([...(current?.queuedInputIds ?? []), ...item.queuedInputIds]),
                ],
                state:
                  current?.state === "accepted" && item.state === "pending"
                    ? "accepted"
                    : item.state,
              });
            }
          }
          operation = {
            ...operation,
            requestKey: existing.requestKey ?? operation.requestKey,
            createdAtMs: existing.createdAtMs,
            state: operation.state === "accepted" ? existing.state : operation.state,
            continuations: [...continuations.values()],
          };
        }
        if (
          !existing &&
          !isTerminalPluginReloadOperation(operation) &&
          entries.filter((entry) => !isTerminalPluginReloadOperation(entry)).length >=
            MAX_ACTIVE_PLUGIN_RELOAD_OPERATIONS
        ) {
          throw new Error("Plugin reload operation capacity reached (32 active operations)");
        }
        writeConfigMachineStateInDatabase(
          db,
          PLUGIN_RELOAD_OPERATION_KEY_PREFIX + operation.id,
          operation,
        );
        const terminalEntries = entries
          .filter((entry) => entry.id !== operation.id)
          .concat(operation)
          .filter(isTerminalPluginReloadOperation)
          .toSorted(
            (left, right) =>
              right.updatedAtMs - left.updatedAtMs ||
              right.createdAtMs - left.createdAtMs ||
              left.id.localeCompare(right.id),
          );
        const prune = terminalEntries.slice(MAX_TERMINAL_PLUGIN_RELOAD_OPERATIONS);
        if (prune.length > 0) {
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<ConfigMachineStateDatabase>(db)
              .deleteFrom("config_machine_state")
              .where(
                "state_key",
                "in",
                prune.map((entry) => PLUGIN_RELOAD_OPERATION_KEY_PREFIX + entry.id),
              ),
          );
        }
        return { type: "machineState.pluginReloadUpsert" as const };
      },
      { operationLabel: "config-machine-state.plugin-reload-upsert" },
    );
  },
  "machineState.configRevisionKey": (
    input: { candidateKey: Uint8Array },
    context: WorkerWriteOperationContext,
  ) =>
    loadOrCreateConfigRevisionKeyInDatabase(
      context.open(),
      input.candidateKey,
      context.stateOptions(),
    ),
  "machineState.write": (
    input: { key: string; value: unknown },
    context: WorkerWriteOperationContext,
  ) => {
    const key = normalizeConfigMachineStateKey(input.key);
    return context.write(
      ({ db }) => {
        if (key !== "authProfiles.store") {
          return writeConfigMachineStateInDatabase(db, key, input.value);
        }
        const { result, receipt } = authProfileCredentialPublication.capture(
          sqlPublicationAnchor(db),
          () => writeConfigMachineStateInDatabase(db, key, input.value),
        );
        deferSqliteWorkerCommitReceipt(sqlPublicationAnchor(db), {
          authCredentials: authProfileCredentialPublication.bound(receipt),
        });
        return result;
      },
      {
        operationLabel: "config-machine-state.write",
        singleStatement: key === "authProfiles.store" ? undefined : true,
      },
    );
  },
};

export type MachineStateWorkerOperations = WorkerOperations<typeof machineStateOperations>;
