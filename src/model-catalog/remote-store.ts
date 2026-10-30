import { readRemoteModelCatalogReceipt } from "../state/config-machine-state-row.js";
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

// Slot name predates the v2 wire; renaming it would discard cached catalogs.
// It must never replace the slot read by released v2 clients, even for the same mirror.
export const REMOTE_MODEL_CATALOG_STATE_KEY = "modelCatalog.remote.v3";
export const PREVIOUS_REMOTE_MODEL_CATALOG_STATE_KEY = "modelCatalog.remote.v2";
// Released v1/v2 snapshots remain readable until this client stores its own.
// Activation still checks source and age; downgrades keep their original slot.
export const LEGACY_REMOTE_MODEL_CATALOG_STATE_KEY = "modelCatalog.remote";

const snapshots = new WeakMap<
  object,
  Map<
    OpenClawStateWorkerContext["databaseEngineSelection"],
    { row: RemoteModelCatalogStoreRow | undefined }
  >
>();

/** Synchronous boot snapshot capture and offline inspection only; refreshes use the worker. */
export function readRemoteModelCatalog(
  options: OpenClawStateDatabaseOptions = {},
): RemoteModelCatalogStoreRow | undefined {
  const snapshot =
    readConfigMachineState<RemoteModelCatalogSnapshot>(REMOTE_MODEL_CATALOG_STATE_KEY, options) ??
    readConfigMachineState<RemoteModelCatalogSnapshot>(
      PREVIOUS_REMOTE_MODEL_CATALOG_STATE_KEY,
      options,
    ) ??
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
  const receipt =
    !artifactPreservingReadOnly &&
    !context.artifactPreservingReads &&
    !context.maintenanceScope &&
    !context.existingSchemaPath
      ? readRemoteModelCatalogReceipt(context.admission.databasePath)
      : undefined;
  const cached = receipt && snapshots.get(receipt)?.get(context.databaseEngineSelection);
  if (cached) {
    context.admission.assertCurrent();
    return cached.row && { ...cached.row };
  }
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  const row = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "modelCatalog.remote.read",
        input: { artifactPreservingReadOnly },
      }),
    { existingOnly: true },
  );
  if (receipt) {
    // An overtaking write retires this captured receipt; the next read reloads.
    const selected = snapshots.get(receipt) ?? new Map();
    selected.set(context.databaseEngineSelection, { row: row && { ...row } });
    snapshots.set(receipt, selected);
  }
  return row;
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
