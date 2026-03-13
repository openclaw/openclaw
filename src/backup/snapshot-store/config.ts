import fs from "node:fs/promises";
import path from "node:path";
import { collectWorkspaceDirs, isPathWithin } from "../../commands/cleanup-utils.js";
import type { BackupConfig, OpenClawConfig } from "../../config/config.js";
import { resolveOAuthDir, resolveStateDir } from "../../config/config.js";
import { normalizeSecretInputString } from "../../config/types.secrets.js";
import { resolveSecretInputString } from "../../secrets/resolve-secret-input-string.js";
import { resolveUserPath } from "../../utils.js";

export type ResolvedSnapshotStoreConfig = {
  targetDir: string;
  encryptionKey: string;
};

/** Target-only config for read-only operations that do not need decryption. */
export type ResolvedSnapshotStoreTargetConfig = {
  targetDir: string;
};

async function canonicalizePathForContainment(inputPath: string): Promise<string> {
  const resolved = path.resolve(inputPath);

  // Reject top-level symlinks early to prevent TOCTOU bypass: an attacker
  // could swap a symlink between this check and a later fs operation.
  try {
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing path that is a symbolic link: ${resolved}`);
    }
  } catch (error) {
    // Re-throw symlink rejection; swallow ENOENT (path may not exist yet).
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw error;
    }
  }

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

/**
 * Resolve and validate the backup target directory from config.
 * Shared by both full config resolution and target-only resolution.
 */
async function resolveValidatedTargetDir(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const backup = resolveConfiguredBackupSection(params.config);
  const target = backup.target;
  if (!target) {
    throw new Error("backup.target is not configured.");
  }

  const targetDir = await canonicalizePathForContainment(resolveUserPath(target));
  const stateDir = await canonicalizePathForContainment(resolveStateDir(params.env));
  const oauthDir = await canonicalizePathForContainment(resolveOAuthDir(params.env, stateDir));
  if (targetDir === stateDir || isPathWithin(targetDir, stateDir)) {
    throw new Error("backup.target must not be inside the live state directory.");
  }
  if (targetDir === oauthDir || isPathWithin(targetDir, oauthDir)) {
    throw new Error("backup.target must not be inside the live OAuth directory.");
  }
  for (const workspaceDir of collectWorkspaceDirs(params.config)) {
    const canonicalWorkspaceDir = await canonicalizePathForContainment(workspaceDir);
    if (targetDir === canonicalWorkspaceDir || isPathWithin(targetDir, canonicalWorkspaceDir)) {
      throw new Error("backup.target must not be inside a workspace being backed up.");
    }
  }

  return targetDir;
}

export async function resolveSnapshotStoreConfig(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<ResolvedSnapshotStoreConfig> {
  const backup = resolveConfiguredBackupSection(params.config);
  const encryptionKey = await resolveSecretInputString({
    config: params.config,
    value: backup.encryption?.key,
    env: params.env,
    normalize: (value) => normalizeSecretInputString(value)?.trim() || undefined,
  });
  if (!encryptionKey) {
    throw new Error("backup.encryption.key is required.");
  }

  const targetDir = await resolveValidatedTargetDir(params);
  return { targetDir, encryptionKey };
}

/**
 * Resolve only the target directory, skipping encryption key validation.
 * Used by read-only operations (e.g. listing snapshots) that only need
 * envelope metadata from disk and never perform decryption.
 */
export async function resolveSnapshotStoreTargetConfig(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<ResolvedSnapshotStoreTargetConfig> {
  const targetDir = await resolveValidatedTargetDir(params);
  return { targetDir };
}
