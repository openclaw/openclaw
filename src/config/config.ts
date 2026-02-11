export {
  createConfigIO,
  loadConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  resolveConfigSnapshotHash,
  writeConfigFile,
} from "./io.js";
export { migrateLegacyConfig } from "./legacy-migrate.js";
export * from "./paths.js";
export * from "./runtime-overrides.js";
export * from "./types.js";
export { validateConfigObject, validateConfigObjectWithPlugins } from "./validation.js";
export { OpenClawSchema } from "./zod-schema.js";

// Atomic Configuration Management
export {
  AtomicConfigManager,
  getAtomicConfigManager,
  applyConfigAtomic,
  emergencyRecoverConfig,
  type AtomicConfigOptions,
  type ConfigBackup,
  type ConfigValidationResult,
  type AtomicApplyResult,
} from "./atomic-config.js";

// Safe Mode Support
export {
  isSafeModeEnabled,
  getSafeModeOptions,
  createSafeModeConfig,
  validateSafeModeConfig,
  applySafeModeRestrictions,
  shouldStartInSafeMode,
  createSafeModeSentinel,
  removeSafeModeSentinel,
  logSafeModeActivation,
  type SafeModeOptions,
} from "./safe-mode.js";

// Startup Safety
export {
  StartupSafetyManager,
  getStartupSafetyManager,
  determineStartupConfig,
  recordStartupFailure,
  markSuccessfulStartup,
  type StartupSafetyOptions,
  type StartupSafetyResult,
  type StartupFailureRecord,
} from "./startup-safety.js";
