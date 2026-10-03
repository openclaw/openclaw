import fs from "node:fs";
import { sha256FileSync } from "./crypto-digest.js";

type LegacyArchiveResolution = {
  targetPath: string;
  action: "archived" | "removed";
};

function archiveLegacyFileSource(params: {
  sourcePath: string;
  label: string;
  warnings: string[];
}): LegacyArchiveResolution | null {
  try {
    let sourceSha256: string | undefined;
    // Reuse any identical archive, including a numbered collision from an earlier run.
    for (let index = 1; ; index++) {
      const targetPath =
        index === 1 ? `${params.sourcePath}.migrated` : `${params.sourcePath}.migrated.${index}`;
      if (!fs.existsSync(targetPath)) {
        fs.renameSync(params.sourcePath, targetPath);
        return { targetPath, action: "archived" };
      }
      // Legacy sources can exceed whole-file allocation limits; hash only collisions.
      sourceSha256 ??= sha256FileSync(params.sourcePath);
      if (sourceSha256 === sha256FileSync(targetPath)) {
        fs.rmSync(params.sourcePath, { force: true });
        return { targetPath, action: "removed" };
      }
    }
  } catch (err) {
    params.warnings.push(`Failed archiving ${params.label} ${params.sourcePath}: ${String(err)}`);
    return null;
  }
}

export function archiveLegacyImportSource(params: {
  sourcePath: string;
  label: string;
  changes: string[];
  warnings: string[];
}): LegacyArchiveResolution | null {
  try {
    fs.chmodSync(params.sourcePath, 0o600);
  } catch (err) {
    params.warnings.push(`Failed securing ${params.label} legacy source: ${String(err)}`);
    return null;
  }
  const resolution = archiveLegacyFileSource({
    sourcePath: params.sourcePath,
    label: `${params.label} legacy source`,
    warnings: params.warnings,
  });
  if (!resolution) {
    return null;
  }
  if (resolution.action === "archived") {
    try {
      fs.chmodSync(resolution.targetPath, 0o600);
    } catch (err) {
      params.warnings.push(
        `Failed securing archived ${params.label} legacy source: ${String(err)}`,
      );
    }
  }
  params.changes.push(
    resolution.action === "removed"
      ? `Removed already-archived ${params.label} legacy source ${params.sourcePath}`
      : `Archived ${params.label} legacy source → ${resolution.targetPath}`,
  );
  return resolution;
}
