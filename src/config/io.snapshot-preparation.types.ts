import type { DeferredPluginMigration } from "../infra/deferred-plugin-migrations.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import type {
  PreparedConfigValidationPluginMetadata,
  ValidateConfigWithPluginsResult,
} from "./validation.types.js";

// Snapshot preparation needs reader inputs, not the config I/O implementation or registry.
export type ConfigSnapshotPreparationContext = {
  deps: { env: NodeJS.ProcessEnv };
  pathResolution: { env: NodeJS.ProcessEnv; homedir?: () => string };
  options: {
    pluginValidation?: "full" | "skip" | "core-only";
    preservedLegacyRootKeys?: readonly string[];
    deferredPluginMigrations?: readonly DeferredPluginMigration[];
  };
};

export type ConfigSnapshotMetadataLoader = {
  load: (
    config: OpenClawConfig,
  ) => Pick<PreparedConfigValidationPluginMetadata, "manifestRegistry">;
  loadAsync: (config: OpenClawConfig) => Promise<PreparedConfigValidationPluginMetadata>;
};

export type ValidationRequest = {
  prepareValidation?: "runtime" | "strict";
  context: ConfigSnapshotPreparationContext;
  metadata: ConfigSnapshotMetadataLoader;
  raw: unknown;
  sourceRaw: unknown;
};
export type PreparedValidation = {
  deferredPluginMigrations?: readonly DeferredPluginMigration[];
  validated: ValidateConfigWithPluginsResult;
};
