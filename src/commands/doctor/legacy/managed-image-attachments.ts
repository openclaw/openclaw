import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../../config/paths.js";
import {
  type ManagedImageRecord,
  writeManagedImageRecord,
} from "../../../gateway/managed-image-attachments.js";
import { tryReadJson } from "../../../infra/json-files.js";

function resolveLegacyOutgoingRecordsDir(stateDir = resolveStateDir()): string {
  return path.join(stateDir, "media", "outgoing", "records");
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
    const record = await tryReadJson<ManagedImageRecord>(recordPath);
    if (record?.attachmentId) {
      await writeManagedImageRecord(record, stateDir);
      records += 1;
    }
    await fs.rm(recordPath, { force: true }).catch(() => {});
  }
  return { files: recordPaths.length, records };
}
