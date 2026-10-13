import { readConfigMachineState } from "../state/config-machine-state.js";
import { isArtifactPreservingStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
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

export type RemoteModelCatalogSnapshot = Omit<RemoteModelCatalogStoreRow, "id">;

export type RemoteModelCatalogWriteResult =
  | { status: "written" }
  | { status: "retained-newer"; row: RemoteModelCatalogStoreRow };

// Older clients retain their v1 slot, including when both versions refresh the same mirror.
export const REMOTE_MODEL_CATALOG_STATE_KEY = "modelCatalog.remote.v2";
// Upgrades read the older client's row until this client stores its own. The row parses as
// a v1 bundle, and activation still checks its source and age. It is never written here, so
// a downgraded client keeps its catalog.
export const LEGACY_REMOTE_MODEL_CATALOG_STATE_KEY = "modelCatalog.remote";

/** Synchronous boot snapshot capture and offline inspection only; refreshes use the worker. */
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

/** Read through the existing shared-state owner, retaining the originally selected store. */
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

export type RemoteModelCatalogCheck = {
  expected: Pick<
    RemoteModelCatalogStoreRow,
    "source_url" | "generated_at" | "etag" | "last_modified"
  >;
  etag?: string | null;
  lastModified?: string | null;
};

export async function writeRemoteModelCatalogAsync(
  row: RemoteModelCatalogSnapshot,
  context: OpenClawStateWorkerContext,
): Promise<RemoteModelCatalogWriteResult> {
  const input = { ...row };
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  const { createSqliteWorkerWriteAdmission } = await import("../infra/sqlite-worker-store.js");
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "modelCatalog.remote.write", input }),
    {
      createAdmission: createSqliteWorkerWriteAdmission(
        () => context.admission.assertCurrent(),
        [context.admission.databasePath],
      ),
    },
  );
}

export async function markRemoteModelCatalogCheckedAsync(
  checkedAt: number,
  metadata: RemoteModelCatalogCheck,
  context: OpenClawStateWorkerContext,
): Promise<boolean> {
  const input = {
    checkedAt,
    metadata: {
      ...metadata,
      expected: {
        source_url: metadata.expected.source_url,
        generated_at: metadata.expected.generated_at,
        etag: metadata.expected.etag,
        last_modified: metadata.expected.last_modified,
      },
    },
  };
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  const { createSqliteWorkerWriteAdmission } = await import("../infra/sqlite-worker-store.js");
  return runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "modelCatalog.remote.markChecked", input }),
    {
      createAdmission: createSqliteWorkerWriteAdmission(
        () => context.admission.assertCurrent(),
        [context.admission.databasePath],
      ),
    },
  );
}
