import path from "node:path";
import type { BackupConfig, OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/config.js";
import { normalizeSecretInputString } from "../../config/types.secrets.js";
import { resolveSecretInputString } from "../../secrets/resolve-secret-input-string.js";
import { resolveUserPath } from "../../utils.js";

export type ResolvedSnapshotStoreConfig = {
  targetDir: string;
  encryptionKey: string;
};

function isPathWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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

  const targetDir = resolveUserPath(target);
  const stateDir = resolveStateDir(params.env);
  if (isPathWithin(targetDir, stateDir)) {
    throw new Error("backup.target must not be inside the live state directory.");
  }

  return {
    targetDir,
    encryptionKey,
  };
}
