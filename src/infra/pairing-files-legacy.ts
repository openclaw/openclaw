import fs from "node:fs/promises";
import { readJsonIfExists } from "./json-files.js";
import {
  coercePairingStateRecord,
  resolvePairingPaths,
  writePairingStateRecord,
} from "./pairing-files.js";

export async function legacyPairingStateFilesExist(params: {
  baseDir?: string;
  subdir: string;
}): Promise<boolean> {
  const { pendingPath, pairedPath } = resolvePairingPaths(params.baseDir, params.subdir);
  const [pendingExists, pairedExists] = await Promise.all([
    fs
      .access(pendingPath)
      .then(() => true)
      .catch(() => false),
    fs
      .access(pairedPath)
      .then(() => true)
      .catch(() => false),
  ]);
  return pendingExists || pairedExists;
}

export async function importLegacyPairingStateFilesToSqlite(params: {
  baseDir?: string;
  subdir: string;
}): Promise<{
  pending: number;
  paired: number;
  files: number;
}> {
  const { pendingPath, pairedPath } = resolvePairingPaths(params.baseDir, params.subdir);
  const [pending, paired] = await Promise.all([
    readJsonIfExists<unknown>(pendingPath),
    readJsonIfExists<unknown>(pairedPath),
  ]);
  const pendingRecord = coercePairingStateRecord<unknown>(pending);
  const pairedRecord = coercePairingStateRecord<unknown>(paired);
  let files = 0;
  if (pending !== undefined) {
    writePairingStateRecord({
      baseDir: params.baseDir,
      subdir: params.subdir,
      key: "pending",
      value: pendingRecord,
    });
    await fs.rm(pendingPath, { force: true }).catch(() => undefined);
    files += 1;
  }
  if (paired !== undefined) {
    writePairingStateRecord({
      baseDir: params.baseDir,
      subdir: params.subdir,
      key: "paired",
      value: pairedRecord,
    });
    await fs.rm(pairedPath, { force: true }).catch(() => undefined);
    files += 1;
  }
  return {
    pending: Object.keys(pendingRecord).length,
    paired: Object.keys(pairedRecord).length,
    files,
  };
}
