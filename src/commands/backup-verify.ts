import type { RuntimeEnv } from "../runtime.js";
import { resolveUserPath } from "../utils.js";
import { readVerifiedBackupArchive } from "./backup-archive.js";

export type BackupVerifyOptions = {
  archive: string;
  json?: boolean;
};

export type BackupVerifyResult = {
  ok: true;
  archivePath: string;
  archiveRoot: string;
  createdAt: string;
  runtimeVersion: string;
  assetCount: number;
  entryCount: number;
};

function formatResult(result: BackupVerifyResult): string {
  return [
    `Validated existing backup archive: ${result.archivePath}`,
    `Archive root: ${result.archiveRoot}`,
    `Created at: ${result.createdAt}`,
    `Runtime version: ${result.runtimeVersion}`,
    `Assets verified: ${result.assetCount}`,
    `Archive entries scanned: ${result.entryCount}`,
  ].join("\n");
}

export async function backupVerifyCommand(
  runtime: RuntimeEnv,
  opts: BackupVerifyOptions,
): Promise<BackupVerifyResult> {
  const archivePath = resolveUserPath(opts.archive);
  const verifiedArchive = await readVerifiedBackupArchive(archivePath);

  const result: BackupVerifyResult = {
    ok: true,
    archivePath,
    archiveRoot: verifiedArchive.manifest.archiveRoot,
    createdAt: verifiedArchive.manifest.createdAt,
    runtimeVersion: verifiedArchive.manifest.runtimeVersion,
    assetCount: verifiedArchive.manifest.assets.length,
    entryCount: verifiedArchive.entryCount,
  };

  runtime.log(opts.json ? JSON.stringify(result, null, 2) : formatResult(result));
  return result;
}
