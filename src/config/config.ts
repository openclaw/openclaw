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
  writeConfigFile as writeConfigFileDirect,
} from "./io.js";
import { runConfigWriteTransaction } from "./transaction.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { ConfigWriteTransactionError } from "./write-failure.js";

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
export * from "./write-failure.js";
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
  const snapshot = await readConfigFileSnapshot();
  // First-time bootstrap writes have no previous state to protect or roll back to.
  // Keep this path simple (single validation + write), then enforce full
  // transactional semantics for subsequent updates.
  if (!snapshot.exists) {
    await writeConfigFileDirect(cfg, options);
    return;
  }

  const transaction = await runConfigWriteTransaction({
    config: cfg,
    writeOptions: options,
  });
  if (transaction.ok) {
    return;
  }

  throw new ConfigWriteTransactionError(transaction);
}
