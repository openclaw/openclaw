import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../../utils.js";

export const DEFAULT_BACKUP_TARGET_DIRNAME = "OpenClaw Backups";

export type DetectedCloudDriveTarget = {
  label: string;
  rootDir: string;
  targetDir: string;
};

function toDetectedTarget(label: string, rootDir: string): DetectedCloudDriveTarget {
  return {
    label,
    rootDir,
    targetDir: path.join(rootDir, DEFAULT_BACKUP_TARGET_DIRNAME),
  };
}

function cloudStoragePriority(name: string): number {
  const normalized = name.toLowerCase();
  if (normalized.startsWith("dropbox")) {
    return 0;
  }
  if (normalized.startsWith("googledrive") || normalized.startsWith("google drive")) {
    return 1;
  }
  if (normalized.startsWith("onedrive")) {
    return 2;
  }
  return 100;
}

export async function detectCloudDriveTargets(params?: {
  platform?: NodeJS.Platform;
  homeDir?: string;
}): Promise<DetectedCloudDriveTarget[]> {
  const platform = params?.platform ?? process.platform;
  const homeDir = params?.homeDir ?? os.homedir();
  const targets: DetectedCloudDriveTarget[] = [];

  if (platform === "darwin") {
    const iCloudRoot = path.join(homeDir, "Library", "Mobile Documents", "com~apple~CloudDocs");
    if (await pathExists(iCloudRoot)) {
      targets.push(toDetectedTarget("iCloud Drive", iCloudRoot));
    }

    const cloudStorageRoot = path.join(homeDir, "Library", "CloudStorage");
    try {
      const entries = await fs.readdir(cloudStorageRoot, { withFileTypes: true });
      const providers = entries
        .filter((entry) => entry.isDirectory())
        .toSorted(
          (left, right) => cloudStoragePriority(left.name) - cloudStoragePriority(right.name),
        );
      for (const entry of providers) {
        targets.push(
          toDetectedTarget(
            entry.name.replaceAll("-", " "),
            path.join(cloudStorageRoot, entry.name),
          ),
        );
      }
    } catch {
      // Best-effort detection only.
    }
  } else {
    const fallbackRoots = [
      { label: "Dropbox", root: path.join(homeDir, "Dropbox") },
      { label: "Google Drive", root: path.join(homeDir, "Google Drive") },
      { label: "Google Drive", root: path.join(homeDir, "GoogleDrive") },
      { label: "OneDrive", root: path.join(homeDir, "OneDrive") },
      { label: "iCloud Drive", root: path.join(homeDir, "iCloudDrive") },
    ];
    for (const candidate of fallbackRoots) {
      if (await pathExists(candidate.root)) {
        targets.push(toDetectedTarget(candidate.label, candidate.root));
      }
    }
  }

  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = path.resolve(target.targetDir);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export async function detectPreferredCloudDriveTarget(params?: {
  platform?: NodeJS.Platform;
  homeDir?: string;
}): Promise<DetectedCloudDriveTarget | undefined> {
  return (await detectCloudDriveTargets(params))[0];
}
