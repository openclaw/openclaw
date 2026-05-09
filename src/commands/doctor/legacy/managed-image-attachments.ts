import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import {
  type ManagedImageRecord,
  writeManagedImageRecord,
} from "../../../gateway/managed-image-attachments.js";
import { tryReadJson } from "../../../infra/json-files.js";
import { saveMediaBufferWithId } from "../../../media/store.js";

function resolveLegacyOutgoingRecordsDir(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "media", "outgoing", "records");
}

type LegacyManagedImageRecord = Omit<ManagedImageRecord, "original"> & {
  original?: Partial<ManagedImageRecord["original"]> & {
    path?: string;
  };
};

function legacyManagedOriginalMediaId(record: LegacyManagedImageRecord): string {
  const filename = record.original?.filename ?? record.original?.path ?? "";
  const ext = path.extname(filename).toLowerCase();
  return /^[.][a-z0-9]{1,16}$/u.test(ext) ? `${record.attachmentId}${ext}` : record.attachmentId;
}

async function importLegacyManagedImageRecord(
  record: LegacyManagedImageRecord,
  stateDir: string,
): Promise<boolean> {
  if (!record.attachmentId || !record.original) {
    return false;
  }
  if (record.original.mediaId && record.original.mediaSubdir) {
    await writeManagedImageRecord(record as ManagedImageRecord, stateDir);
    return true;
  }
  if (!record.original.path) {
    return false;
  }
  const buffer = await fs.readFile(record.original.path).catch(() => null);
  if (!buffer) {
    return false;
  }
  const mediaId = legacyManagedOriginalMediaId(record);
  await saveMediaBufferWithId({
    subdir: "outgoing/originals",
    id: mediaId,
    buffer,
    contentType: record.original.contentType ?? "application/octet-stream",
  });
  await writeManagedImageRecord(
    {
      ...record,
      original: {
        mediaId,
        mediaSubdir: "outgoing/originals",
        contentType: record.original.contentType ?? "application/octet-stream",
        width: record.original.width ?? null,
        height: record.original.height ?? null,
        sizeBytes: record.original.sizeBytes ?? buffer.byteLength,
        filename: record.original.filename ?? path.basename(record.original.path),
      },
    },
    stateDir,
  );
  await fs.rm(record.original.path, { force: true }).catch(() => {});
  return true;
}

async function listLegacyManagedImageRecordPaths(stateDir: string): Promise<string[]> {
  const recordsDir = resolveLegacyOutgoingRecordsDir(stateDir);
  let names: string[] = [];
  try {
    names = await fs.readdir(recordsDir);
  } catch {
    names = [];
  }
  const paths: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    paths.push(path.join(recordsDir, name));
  }
  return paths;
}

export async function legacyManagedOutgoingImageRecordFilesExist(
  stateDir = resolveStateDir(),
): Promise<boolean> {
  return (await listLegacyManagedImageRecordPaths(stateDir)).length > 0;
}

export async function importLegacyManagedOutgoingImageRecordFilesToSqlite(
  stateDir = resolveStateDir(),
): Promise<{ files: number; records: number }> {
  const recordPaths = await listLegacyManagedImageRecordPaths(stateDir);
  let records = 0;
  for (const recordPath of recordPaths) {
    const record = await tryReadJson<LegacyManagedImageRecord>(recordPath);
    if (record && (await importLegacyManagedImageRecord(record, stateDir))) {
      records += 1;
    }
    await fs.rm(recordPath, { force: true }).catch(() => {});
  }
  return { files: recordPaths.length, records };
}
