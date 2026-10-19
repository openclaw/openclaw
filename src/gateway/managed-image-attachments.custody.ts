import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/state-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { getMediaDir } from "../media/store.js";
import { captureChannelReadScope } from "../shared/channel-read-authority.js";
import {
  captureManagedImageContext,
  claimManagedImageRecordCleanupIfCurrent,
  deleteClaimedManagedImageRecord,
  insertManagedImageRecord,
  listManagedImageOriginalMediaIds,
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

function resolveManagedImageOriginalsDir(stateDir: string): string {
  const runtimeMediaRoot =
    path.resolve(stateDir) === path.resolve(resolveStateDir())
      ? getMediaDir()
      : path.join(stateDir, "media");
  return path.join(runtimeMediaRoot, MANAGED_OUTGOING_ORIGINALS_SUBDIR);
}

async function hasUnmigratedManagedImageMetadata(stateDir: string): Promise<boolean> {
  try {
    const names = await fs.readdir(path.join(stateDir, "media", "outgoing", "records"));
    return names.some((name) => name.endsWith(".json") || name.includes(".json.doctor-importing-"));
  } catch (error) {
    return !hasErrnoCode(error, "ENOENT");
  }
}

export async function deleteAgedOrphanManagedImageFiles(params: {
  stateDir: string;
  nowMs: number;
  minAgeMs: number;
}): Promise<number> {
  // Destructive migration barrier only: runtime never parses or serves legacy metadata.
  // Any legacy source may own an old file, so Doctor must retire all JSON before orphan reaping.
  if (await hasUnmigratedManagedImageMetadata(params.stateDir)) {
    return 0;
  }
  let referencedMediaIds: Set<string> | undefined;
  const originalsDir = resolveManagedImageOriginalsDir(params.stateDir);
  let names: string[];
  try {
    names = await fs.readdir(originalsDir);
  } catch {
    return 0;
  }
  let deletedCount = 0;
  for (const name of names) {
    if (referencedMediaIds?.has(name)) {
      continue;
    }
    const filePath = path.join(originalsDir, name);
    const stat = await fs.lstat(filePath).catch(() => undefined);
    if (!stat?.isFile() || params.nowMs - stat.mtimeMs < params.minAgeMs) {
      continue;
    }
    referencedMediaIds ??= new Set(await listManagedImageOriginalMediaIds(params.stateDir));
    if (referencedMediaIds.has(name)) {
      continue;
    }
    try {
      await fs.rm(filePath, { force: true });
      deletedCount += 1;
    } catch {
      // A later maintenance pass retries transient filesystem failures and races.
    }
  }
  return deletedCount;
}
