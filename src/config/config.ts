import type { ConfigWriteOptions } from "./io.js";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  createConfigIO,
  getRuntimeConfigSnapshot,
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
  setRuntimeConfigSnapshot,
} from "./io.js";
import { runConfigWriteTransaction } from "./transaction.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  createConfigIO,
  getRuntimeConfigSnapshot,
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
  setRuntimeConfigSnapshot,
};
export { migrateLegacyConfig } from "./legacy-migrate.js";
export * from "./paths.js";
export * from "./runtime-overrides.js";
export * from "./types.js";
export {
  validateConfigObject,
  validateConfigObjectRaw,
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "./validation.js";
export { recoverConfigFromBackups, runConfigWriteTransaction } from "./transaction.js";

export async function writeConfigFile(
  cfg: OpenClawConfig,
  options: ConfigWriteOptions = {},
): Promise<void> {
  const transaction = await runConfigWriteTransaction({
    config: cfg,
    writeOptions: options,
  });
  if (transaction.ok) {
    return;
  }

  const stageLabel = transaction.stage ? ` stage=${transaction.stage};` : "";
  const rollbackLabel = transaction.rolledBack ? " rollback=ok;" : "";
  throw new Error(
    `writeConfigFile transaction failed;${stageLabel}${rollbackLabel} ${
      transaction.error ?? "unknown error"
    }`,
  );
}
