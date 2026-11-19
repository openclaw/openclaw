import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import {
  buildBackupArchiveBasename,
  resolveBackupArchivePath,
  type BackupAsset,
} from "../commands/backup-shared.js";
import { resolveHomeDir } from "../utils.js";
import { safeStat } from "./path-existence.js";

export async function resolveBackupOutputPath(params: {
  output?: string;
  nowMs: number;
  includedAssets: BackupAsset[];
  stateDir: string;
  preferHomeOutput?: boolean;
}): Promise<string> {
  const basename = buildBackupArchiveBasename(params.nowMs);
  const rawOutput = params.output;
  if (!rawOutput?.trim()) {
    const insideSource = async (dir: string) => {
      const canonical = await fs.realpath(dir).catch(() => dir);
      return params.includedAssets.some((asset) => isPathInside(asset.sourcePath, canonical));
    };
    const home = resolveHomeDir();
    if (params.preferHomeOutput && home && !(await insideSource(path.resolve(home)))) {
      return path.resolve(home, basename);
    }
    const cwd = path.resolve(process.cwd());
    const defaultDir = (await insideSource(cwd)) ? (home ?? path.dirname(params.stateDir)) : cwd;
    return path.resolve(defaultDir, basename);
  }

  const resolved = resolveBackupArchivePath(rawOutput, "--output");
  if (rawOutput.endsWith("/") || rawOutput.endsWith("\\")) {
    return path.join(resolved, basename);
  }

  if ((await safeStat(resolved))?.isDirectory()) {
    return path.join(resolved, basename);
  }

  return resolved;
}
