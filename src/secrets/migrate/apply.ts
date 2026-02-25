import fs from "node:fs";
import { ensureDirForFile, writeJsonFileSecure } from "../shared.js";
import { encryptSopsJsonFile } from "../sops.js";
import {
  createBackupManifest,
  pruneOldBackups,
  resolveUniqueBackupId,
  restoreFromManifest,
} from "./backup.js";
import { createSecretsMigrationConfigIO } from "./config-io.js";
import type { MigrationPlan, SecretsMigrationRunResult } from "./types.js";

async function encryptSopsJson(params: {
  pathname: string;
  timeoutMs: number;
  payload: Record<string, unknown>;
  sopsConfigPath?: string;
}): Promise<void> {
  await encryptSopsJsonFile({
    path: params.pathname,
    payload: params.payload,
    timeoutMs: params.timeoutMs,
    configPath: params.sopsConfigPath,
    missingBinaryMessage:
      "sops binary not found in PATH. Install sops >= 3.9.0 to run secrets migrate.",
  });
}

export async function applyMigrationPlan(params: {
  plan: MigrationPlan;
  env: NodeJS.ProcessEnv;
  now: Date;
}): Promise<SecretsMigrationRunResult> {
  const { plan } = params;
  if (!plan.changed) {
    return {
      mode: "write",
      changed: false,
      secretsFilePath: plan.secretsFilePath,
      counters: plan.counters,
      changedFiles: [],
    };
  }

  const backupId = resolveUniqueBackupId(plan.stateDir, params.now);
  const backup = createBackupManifest({
    stateDir: plan.stateDir,
    targets: plan.backupTargets,
    backupId,
    now: params.now,
  });

  try {
    if (plan.payloadChanged) {
      await encryptSopsJson({
        pathname: plan.secretsFilePath,
        timeoutMs: plan.secretsFileTimeoutMs,
        payload: plan.nextPayload,
        sopsConfigPath: plan.sopsConfigPath,
      });
    }

    if (plan.configChanged) {
      const io = createSecretsMigrationConfigIO({ env: params.env });
      await io.writeConfigFile(plan.nextConfig, plan.configWriteOptions);
    }

    for (const change of plan.authStoreChanges) {
      writeJsonFileSecure(change.path, change.nextStore);
    }

    if (plan.envChange) {
      ensureDirForFile(plan.envChange.path);
      fs.writeFileSync(plan.envChange.path, plan.envChange.nextRaw, "utf8");
      fs.chmodSync(plan.envChange.path, 0o600);
    }
  } catch (err) {
    restoreFromManifest(backup.manifest);
    throw new Error(
      `Secrets migration failed and was rolled back from backup ${backupId}: ${String(err)}`,
      {
        cause: err,
      },
    );
  }

  pruneOldBackups(plan.stateDir);

  return {
    mode: "write",
    changed: true,
    backupId,
    backupDir: backup.backupDir,
    secretsFilePath: plan.secretsFilePath,
    counters: plan.counters,
    changedFiles: plan.backupTargets,
  };
}
