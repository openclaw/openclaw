// Canonical shared-SQLite store for managed outgoing image metadata.
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type {
  ManagedImageRecord,
  ManagedImageWriteOperations,
  ManagedImageRecordEntry,
} from "./managed-image-record-store.types.js";

export {
  managedImageRecordToRow,
  managedImageRecordFromRow,
  managedImageRecordsEqual,
} from "./managed-image-record-store.kernel.js";
export type {
  ManagedImageRecord,
  ManagedImageRecordDatabase,
} from "./managed-image-record-store.types.js";
export const MANAGED_OUTGOING_ORIGINALS_SUBDIR = "outgoing/originals";

function captureManagedImageContext(stateDir?: string) {
  const env = cloneEnvWithPlatformSemantics(process.env);
  if (stateDir) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }
  return captureOpenClawStateWorkerContext({ env });
}

export async function readManagedImageRecord(
  attachmentId: string,
  stateDir?: string,
): Promise<ManagedImageRecord | null> {
  const context = captureManagedImageContext(stateDir);
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "managedImages.read",
    input: { attachmentId },
  });
}

export async function listManagedImageRecordEntries(params: {
  stateDir?: string;
  sessionKey?: string;
}): Promise<ManagedImageRecordEntry[]> {
  const context = captureManagedImageContext(params.stateDir);
  const sessionKey = params.sessionKey;
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "managedImages.entries",
    input: { sessionKey },
  });
}

export async function listManagedImageOriginalMediaIds(stateDir?: string): Promise<string[]> {
  const context = captureManagedImageContext(stateDir);
  const { executeOpenClawStateWorker } = await import("../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "managedImages.originalMediaIds",
    input: undefined,
  });
}

async function mutateManagedImageRecord<C extends SqliteWorkerCommand<ManagedImageWriteOperations>>(
  command: C,
  stateDir?: string,
  assertCurrent?: () => void,
): Promise<ManagedImageWriteOperations[C["type"]]["output"]> {
  const context = captureManagedImageContext(stateDir);
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  return runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command), {
    assertCurrent,
    createAdmission: () => ({
      nativeLocations: [context.admission.databasePath],
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        if (request.stage !== "transaction") {
          throw new Error("Managed media persistence requires transaction admission");
        }
        context.admission.assertCurrent();
        assertCurrent?.();
        grant();
      }),
    }),
  });
}

export async function insertManagedImageRecord(
  record: ManagedImageRecord,
  stateDir?: string,
  assertCurrent?: () => void,
): Promise<void> {
  await mutateManagedImageRecord(
    { type: "managedImages.insert", input: { record } },
    stateDir,
    assertCurrent,
  );
}

export async function attachManagedImageRecordToMessage(params: {
  attachmentId: string;
  sessionKey: string;
  messageId: string;
  updatedAt: string;
  stateDir?: string;
  assertCurrent?: () => void;
}): Promise<boolean> {
  const { stateDir, assertCurrent, ...input } = params;
  return mutateManagedImageRecord({ type: "managedImages.attach", input }, stateDir, assertCurrent);
}

export async function claimManagedImageRecordCleanupIfCurrent(
  planned: ManagedImageRecord,
  stateDir?: string,
): Promise<boolean> {
  return mutateManagedImageRecord(
    { type: "managedImages.claimCleanup", input: { record: planned } },
    stateDir,
  );
}

export async function deleteClaimedManagedImageRecord(
  planned: ManagedImageRecord,
  stateDir?: string,
): Promise<boolean> {
  return mutateManagedImageRecord(
    { type: "managedImages.deleteClaimed", input: { record: planned } },
    stateDir,
  );
}
