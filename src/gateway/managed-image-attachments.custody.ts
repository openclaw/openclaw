import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { captureChannelReadScope } from "../shared/channel-read-authority.js";
import {
  captureManagedImageContext,
  claimManagedImageRecordCleanupIfCurrent,
  deleteClaimedManagedImageRecord,
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  type ManagedImageRecord,
} from "./managed-image-record-store.js";

export function resolveManagedImageOriginalPath(record: ManagedImageRecord) {
  if (
    !path.isAbsolute(record.original.mediaRoot) ||
    record.original.mediaSubdir !== MANAGED_OUTGOING_ORIGINALS_SUBDIR ||
    !record.original.mediaId ||
    record.original.mediaId.includes("/") ||
    record.original.mediaId.includes("\\") ||
    record.original.mediaId.includes("\0")
  ) {
    throw new Error("Managed image record has an unsafe media identity");
  }
  return path.join(record.original.mediaRoot, record.original.mediaSubdir, record.original.mediaId);
}

export async function deleteManagedImageRecordArtifacts(
  record: ManagedImageRecord,
  stateDir = resolveStateDir(),
  alreadyClaimed = false,
  context = captureManagedImageContext(stateDir),
) {
  if (
    !alreadyClaimed &&
    !(await claimManagedImageRecordCleanupIfCurrent(record, stateDir, context))
  ) {
    return { deletedRecord: false, deletedFileCount: 0 };
  }
  context.admission.assertCurrent();
  try {
    await fs.rm(resolveManagedImageOriginalPath(record), { force: true });
  } catch {
    // Keep the durable cleanup claim so the next sweep retries this exact file.
    return { deletedRecord: false, deletedFileCount: 0 };
  }
  return {
    deletedRecord: await deleteClaimedManagedImageRecord(record, stateDir, context),
    deletedFileCount: 1,
  };
}

export async function insertManagedImageRecordWithFile(
  record: ManagedImageRecord,
  originalPath: string,
  stateDir: string,
  context: ReturnType<typeof captureManagedImageContext>,
): Promise<void> {
  const readScope = captureChannelReadScope();
  let settlement: Promise<void> | undefined;
  if (
    readScope &&
    !readScope.delegateResource(
      originalPath,
      (accepted, settleFile) =>
        (settlement ??= (async () => {
          try {
            await insertion;
          } catch (error) {
            // An uncertain insert may already own these bytes; rejection still fences disclosure.
            await settleFile(hasSqliteWorkerOutcomeUnknown(error));
            return;
          }
          if (accepted) {
            await settleFile(true);
            return;
          }
          let claimed = false;
          try {
            const applied = await claimManagedImageRecordCleanupIfCurrent(
              record,
              stateDir,
              context,
            );
            context.admission.assertCurrent();
            claimed = applied;
          } finally {
            // A changed or uncertain row keeps its descriptor's bytes.
            await settleFile(!claimed);
          }
          if (claimed) {
            try {
              await fs.lstat(originalPath);
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                await deleteClaimedManagedImageRecord(record, stateDir, context);
                return;
              }
              throw error;
            }
          }
        })()),
      context.admission.assertCurrent,
    )
  ) {
    throw new Error("Managed media has no retained file resource");
  }
  const insertion = insertManagedImageRecord(record, stateDir, context);
  await insertion;
}
