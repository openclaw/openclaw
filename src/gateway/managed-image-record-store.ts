import { isRecord } from "@openclaw/normalization-core/record-coerce";
// Canonical shared-SQLite store for managed outgoing image metadata.
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { captureChannelReadAuthority } from "../shared/channel-read-authority.js";
import { createKeyedFifoLeaseRegistry } from "../shared/keyed-fifo-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type {
  ManagedImageRecord,
  ManagedImageRecordAttachment,
  ManagedImageRecordMutation,
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

const mutations = createKeyedFifoLeaseRegistry(Symbol.for("openclaw.managedImageRecordMutations"));

export function captureManagedImageContext(stateDir?: string) {
  const env = cloneEnvWithPlatformSemantics(process.env);
  if (stateDir) {
    env.OPENCLAW_STATE_DIR = stateDir;
  }
  return captureOpenClawStateWorkerContext({ env });
}

export async function readManagedImageRecord(
  attachmentId: string,
  stateDir?: string,
  context = captureManagedImageContext(stateDir),
): Promise<ManagedImageRecord | null> {
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

function mutateManagedImageRecords(
  commands: readonly ManagedImageRecordMutation[],
  context: OpenClawStateWorkerContext,
  assertCurrent?: () => void,
): Promise<boolean> {
  const prepared = structuredClone(commands);
  return trackAsyncWork(async () => {
    const lease = mutations.reserve(
      prepared.map(({ input }) =>
        JSON.stringify([context.admission.coordinationKey, input.attachmentId]),
      ),
    );
    try {
      await lease?.wait();
      const { runOpenClawStateWorkerOperation } =
        await import("../state/openclaw-state-worker-store.js");
      let result = true;
      for (const command of prepared) {
        let admission: SqliteWorkerOperationAdmission | undefined;
        const check = () => {
          context.admission.assertCurrent();
          assertCurrent?.();
        };
        let applied: boolean;
        try {
          applied = await runOpenClawStateWorkerOperation(
            context,
            (scope) => scope.execute(command),
            {
              assertCurrent: check,
              createAdmission: () => {
                admission = createSqliteWorkerOperationAdmission((_request, grant) => {
                  check();
                  if (!grant()) {
                    throw new Error("Managed media write admission expired");
                  }
                });
                return { admission, nativeLocations: [context.admission.databasePath] };
              },
            },
          );
        } catch (error) {
          const committed = admission?.committed ?? admission?.settlement?.committed;
          if (
            !committed ||
            !isRecord(committed.facts) ||
            committed.facts.type !== command.type ||
            typeof committed.facts.result !== "boolean"
          ) {
            throw error;
          }
          // A lost ordinary reply cannot revoke the exact mutation's native commit.
          applied = committed.facts.result;
        }
        result = applied && result;
      }
      return result;
    } finally {
      // The broker joins native settlement before the next attachment or cleanup may enter.
      lease?.release();
    }
  });
}

/** The file owner records this commit before separately fencing result disclosure. */
export async function insertManagedImageRecord(
  record: ManagedImageRecord,
  stateDir?: string,
  context = captureManagedImageContext(stateDir),
): Promise<void> {
  await mutateManagedImageRecords(
    [{ type: "managedImages.insert", input: record }],
    context,
    captureChannelReadAuthority(),
  );
}

/** Reserve every referenced record before yielding; each promotion keeps its own transaction. */
export async function attachManagedImageRecordsToMessage(params: {
  attachments: readonly Pick<ManagedImageRecordAttachment, "attachmentId" | "sessionKey">[];
  messageId: string;
  updatedAt: string;
  stateDir?: string;
}): Promise<boolean> {
  const context = captureManagedImageContext(params.stateDir);
  const result = await mutateManagedImageRecords(
    params.attachments.map((attachment) => ({
      type: "managedImages.attach",
      input: { ...attachment, messageId: params.messageId, updatedAt: params.updatedAt },
    })),
    context,
  );
  context.admission.assertCurrent();
  return result;
}

export async function claimManagedImageRecordCleanupIfCurrent(
  planned: ManagedImageRecord,
  stateDir?: string,
  context = captureManagedImageContext(stateDir),
): Promise<boolean> {
  const result = await mutateManagedImageRecords(
    [{ type: "managedImages.claimCleanup", input: planned }],
    context,
  );
  context.admission.assertCurrent();
  return result;
}

export async function deleteClaimedManagedImageRecord(
  planned: ManagedImageRecord,
  stateDir?: string,
  context = captureManagedImageContext(stateDir),
): Promise<boolean> {
  const result = await mutateManagedImageRecords(
    [{ type: "managedImages.deleteClaimed", input: planned }],
    context,
  );
  context.admission.assertCurrent();
  return result;
}
