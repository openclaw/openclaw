import {
  updateConfigMachineState,
  updateConfigMachineStateInDatabase,
} from "../state/config-machine-state-write.js";
import {
  readConfigMachineState,
  readConfigMachineStateRowInDatabase,
} from "../state/config-machine-state.js";
import { isArtifactPreservingStateRead } from "../state/openclaw-state-db-readonly.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";

type RemoteModelCatalogStoreRow = {
  id: number;
  bundle_json: string;
  generated_at: number;
  min_version: string | null;
  source_url: string;
  etag: string | null;
  last_modified: string | null;
  checked_at: number;
};

type RemoteModelCatalogSnapshot = Omit<RemoteModelCatalogStoreRow, "id">;

type RemoteModelCatalogWriteResult =
  | { status: "written" }
  | { status: "retained-newer"; row: RemoteModelCatalogStoreRow };

// Older clients retain their v1 slot, including when both versions refresh the same mirror.
const REMOTE_MODEL_CATALOG_STATE_KEY = "modelCatalog.remote.v2";
// Upgrades read the older client's row until this client stores its own. The row parses as
// a v1 bundle, and activation still checks its source and age. It is never written here, so
// a downgraded client keeps its catalog.
const LEGACY_REMOTE_MODEL_CATALOG_STATE_KEY = "modelCatalog.remote";

export function readRemoteModelCatalog(
  options: OpenClawStateDatabaseOptions = {},
): RemoteModelCatalogStoreRow | undefined {
  const snapshot =
    readConfigMachineState<RemoteModelCatalogSnapshot>(REMOTE_MODEL_CATALOG_STATE_KEY, options) ??
    readConfigMachineState<RemoteModelCatalogSnapshot>(
      LEGACY_REMOTE_MODEL_CATALOG_STATE_KEY,
      options,
    );
  return snapshot ? { id: 1, ...snapshot } : undefined;
}

/** Read the startup catalog through the existing shared-state inspection owner. */
export async function readRemoteModelCatalogAsync(
  context: OpenClawStateWorkerContext,
): Promise<RemoteModelCatalogStoreRow | undefined> {
  const artifactPreservingReadOnly = isArtifactPreservingStateRead();
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  context.admission.assertCurrent();
  return runOpenClawStateWorkerOperation(
    context,
    async (scope) => {
      const row = await scope.execute({
        type: "modelCatalog.remote.read",
        input: { artifactPreservingReadOnly },
      });
      context.admission.assertCurrent();
      return row;
    },
    { existingOnly: true },
  );
}

export function writeRemoteModelCatalog(
  row: RemoteModelCatalogSnapshot,
  options: OpenClawStateDatabaseOptions = {},
): RemoteModelCatalogWriteResult {
  let result: RemoteModelCatalogWriteResult = { status: "written" };
  updateConfigMachineState<RemoteModelCatalogSnapshot>(
    REMOTE_MODEL_CATALOG_STATE_KEY,
    (current) => {
      // CLI and Gateway refreshes race across processes; compare inside the write transaction.
      if (
        current &&
        current.source_url === row.source_url &&
        (current.generated_at > row.generated_at ||
          (current.generated_at === row.generated_at && current.bundle_json !== row.bundle_json))
      ) {
        result = { status: "retained-newer", row: { id: 1, ...current } };
        return current;
      }
      return row;
    },
    options,
  );
  return result;
}

export function markRemoteModelCatalogChecked(
  checkedAt: number,
  metadata: {
    expected: Pick<
      RemoteModelCatalogStoreRow,
      "source_url" | "generated_at" | "etag" | "last_modified"
    >;
    etag?: string | null;
    lastModified?: string | null;
  },
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  let matched = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Read the legacy slot in this transaction so an older client's concurrent refresh
      // is seen. Only a matching legacy row is adopted into this client's slot; the legacy
      // slot itself is never written.
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
    },
    options,
    { operationLabel: "model-catalog.remote.mark-checked" },
  );
  return matched;
}
