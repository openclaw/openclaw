import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { updateConfigMachineStateInDatabase } from "../state/config-machine-state-write.js";
import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import {
  readRemoteModelCatalog,
  REMOTE_MODEL_CATALOG_STATE_KEY,
  LEGACY_REMOTE_MODEL_CATALOG_STATE_KEY,
  type RemoteModelCatalogSnapshot,
  type RemoteModelCatalogWriteResult,
  type RemoteModelCatalogCheck,
} from "./remote-store.js";

export const modelCatalogOperations = {
  "modelCatalog.remote.read": (
    input: { artifactPreservingReadOnly: boolean },
    { stateOptions },
  ) => {
    const read = () => readRemoteModelCatalog(stateOptions());
    return input.artifactPreservingReadOnly ? withArtifactPreservingStateReads(read) : read();
  },
  "modelCatalog.remote.write": (
    row: RemoteModelCatalogSnapshot,
    { open, stateOptions },
  ): RemoteModelCatalogWriteResult =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        let result: RemoteModelCatalogWriteResult = { status: "written" };
        updateConfigMachineStateInDatabase<RemoteModelCatalogSnapshot>(
          db,
          REMOTE_MODEL_CATALOG_STATE_KEY,
          (current) => {
            // A fetch may finish behind a newer CLI or Gateway refresh. Compare under the lock.
            if (
              current &&
              current.source_url === row.source_url &&
              (current.generated_at > row.generated_at ||
                (current.generated_at === row.generated_at &&
                  current.bundle_json !== row.bundle_json))
            ) {
              result = { status: "retained-newer", row: { id: 1, ...current } };
              return current;
            }
            return row;
          },
          Date.now(),
        );
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return result;
      },
      { ...stateOptions(), database: open() },
    ),
  "modelCatalog.remote.markChecked": (
    { checkedAt, metadata }: { checkedAt: number; metadata: RemoteModelCatalogCheck },
    { open, stateOptions },
  ): boolean =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        let matched = false;
        // Reread the legacy slot under the lock; adoption must not overwrite a concurrent refresh.
        const legacyJson = readConfigMachineStateRowInDatabase(
          db,
          LEGACY_REMOTE_MODEL_CATALOG_STATE_KEY,
        )?.value_json;
        let legacy: RemoteModelCatalogSnapshot | undefined;
        if (legacyJson !== undefined) {
          // SAFETY: Only OpenClaw catalog stores write this key, always as a catalog snapshot.
          legacy = JSON.parse(legacyJson) as RemoteModelCatalogSnapshot;
        }
        updateConfigMachineStateInDatabase<RemoteModelCatalogSnapshot>(
          db,
          REMOTE_MODEL_CATALOG_STATE_KEY,
          (stored) => {
            const current = stored ?? legacy;
            if (
              !current ||
              current.source_url !== metadata.expected.source_url ||
              current.generated_at !== metadata.expected.generated_at ||
              current.etag !== metadata.expected.etag ||
              current.last_modified !== metadata.expected.last_modified
            ) {
              return stored;
            }
            matched = true;
            return {
              ...current,
              checked_at: checkedAt,
              ...(metadata.etag !== undefined ? { etag: metadata.etag } : {}),
              ...(metadata.lastModified !== undefined
                ? { last_modified: metadata.lastModified }
                : {}),
            };
          },
          Date.now(),
        );
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return matched;
      },
      { ...stateOptions(), database: open() },
    ),
} satisfies WorkerOperationHandlers;

export type ModelCatalogWorkerOperations = WorkerOperations<typeof modelCatalogOperations>;
