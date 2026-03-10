import fs from "node:fs/promises";
import path from "node:path";
import { collectWorkspaceDirs, isPathWithin } from "../../commands/cleanup-utils.js";
import type { BackupConfig, OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/config.js";
import { normalizeSecretInputString } from "../../config/types.secrets.js";
import { resolveSecretInputString } from "../../secrets/resolve-secret-input-string.js";
import { resolveUserPath } from "../../utils.js";

export type ResolvedSnapshotStoreConfig = {
  targetDir: string;
  encryptionKey: string;
};

async function canonicalizePathForContainment(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);
  const suffix: string[] = [];
  let probe = resolved;
  while (true) {
    try {
      const real = await fs.realpath(probe);
      return suffix.length === 0 ? real : path.join(real, ...suffix.toReversed());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return resolved;
      }
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

function resolveConfiguredBackupSection(cfg: OpenClawConfig): NonNullable<BackupConfig> {
  const backup = cfg.backup;
  if (!backup?.target?.trim()) {
    throw new Error("backup.target is not configured.");
  }
  return backup;
}

export async function resolveSnapshotStoreConfig(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<ResolvedSnapshotStoreConfig> {
  const backup = resolveConfiguredBackupSection(params.config);
  const target = backup.target;
  if (!target) {
    throw new Error("backup.target is not configured.");
  }
  const encryptionKey = await resolveSecretInputString({
    config: params.config,
    value: backup.encryption?.key,
    env: params.env,
    normalize: (value) => normalizeSecretInputString(value)?.trim() || undefined,
  });
  if (!encryptionKey) {
    throw new Error("backup.encryption.key is required.");
  }

  const targetDir = await canonicalizePathForContainment(resolveUserPath(target));
  const stateDir = await canonicalizePathForContainment(resolveStateDir(params.env));
  if (isPathWithin(targetDir, stateDir)) {
    throw new Error("backup.target must not be inside the live state directory.");
  }
  for (const workspaceDir of collectWorkspaceDirs(params.config)) {
    const canonicalWorkspaceDir = await canonicalizePathForContainment(workspaceDir);
    if (isPathWithin(targetDir, canonicalWorkspaceDir)) {
      throw new Error("backup.target must not be inside a workspace being backed up.");
    }
  }

  return {
    targetDir,
    encryptionKey,
  };
}
