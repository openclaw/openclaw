import fs from "node:fs";
import { sha256FileSync } from "./crypto-digest.js";

export function archiveLegacyImportSource(params: {
  sourcePath: string;
  label: string;
  changes: string[];
  warnings: string[];
  deduplicate?: boolean;
}): void {
  try {
    fs.chmodSync(params.sourcePath, 0o600);
  } catch (err) {
    params.warnings.push(`Failed securing ${params.label} legacy source: ${String(err)}`);
    return;
  }
  try {
    let sourceSha256: string | undefined;
    // By default, reuse identical archives, including numbered collisions from earlier runs.
    for (let index = 1; ; index++) {
      const targetPath =
        index === 1 ? `${params.sourcePath}.migrated` : `${params.sourcePath}.migrated.${index}`;
      if (!fs.existsSync(targetPath)) {
        fs.renameSync(params.sourcePath, targetPath);
        try {
          fs.chmodSync(targetPath, 0o600);
        } catch (err) {
          params.warnings.push(
            `Failed securing archived ${params.label} legacy source: ${String(err)}`,
          );
        }
        params.changes.push(`Archived ${params.label} legacy source → ${targetPath}`);
        return;
      }
      if (params.deduplicate === false) {
        continue;
      }
      // Legacy sources can exceed whole-file allocation limits; hash only collisions.
      sourceSha256 ??= sha256FileSync(params.sourcePath);
      if (sourceSha256 === sha256FileSync(targetPath)) {
        fs.rmSync(params.sourcePath, { force: true });
        params.changes.push(
          `Removed already-archived ${params.label} legacy source ${params.sourcePath}`,
        );
        return;
      }
    }
  } catch (err) {
    params.warnings.push(
      `Failed archiving ${params.label} legacy source ${params.sourcePath}: ${String(err)}`,
    );
  }
}
