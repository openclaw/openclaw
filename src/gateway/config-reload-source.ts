import { isDeepStrictEqual } from "node:util";
import type { ConfigWriteNotification } from "../config/io.js";
import type { RuntimeConfigSnapshotRefreshOptions } from "../config/runtime-snapshot.js";
import type { RuntimeConfigWriteApplicationClaim } from "../config/runtime-write-application.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { omitRuntimeConfigPaths } from "../config/validation-runtime.js";
import { PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import type { GatewayReloadPlan } from "./config-reload-plan.js";
import { GatewayConfigReloadSupersededError } from "./server-reload-contracts.js";

export type PreparedGatewayConfigCandidate = {
  runtimeConfig: OpenClawConfig;
  compareConfig: OpenClawConfig;
  runtimeEnv?: NonNullable<ConfigWriteNotification["preparedCandidate"]>["runtimeEnv"];
  reapplyRuntimeOverlays?: (config: OpenClawConfig) => OpenClawConfig;
  reapplyCompareOverlays?: (config: OpenClawConfig) => OpenClawConfig;
};

export function asPluginInstallConfig(
  records: Record<string, PluginInstallRecord>,
): OpenClawConfig {
  return {
    plugins: {
      installs: records,
    },
  };
}

export function prepareReloadCompareConfig(
  config: OpenClawConfig,
  ignoredPaths: ConfigFileSnapshot["runtimeIgnoredPaths"],
  reapplyOverlays?: (config: OpenClawConfig) => OpenClawConfig,
): OpenClawConfig {
  if (!ignoredPaths?.length) {
    return config;
  }
  // SAFETY: validation qualified these paths as omissions from this config generation.
  const projected = omitRuntimeConfigPaths(config, ignoredPaths) as OpenClawConfig;
  // Validation excludes authored paths, not independently applied runtime overrides.
  return reapplyOverlays?.(projected) ?? projected;
}

export function isConfigReloadSuperseded(error: unknown): boolean {
  // Only completed rollback preserves the direct cause. Cleanup failures and
  // published replacements must settle instead of transferring the write.
  const cause =
    error instanceof PluginRuntimeApplicationError && !error.details.committed
      ? error.cause
      : error;
  return cause instanceof GatewayConfigReloadSupersededError;
}

function readSourcePath(config: OpenClawConfig, path: readonly (string | number)[]): unknown {
  let value: unknown = config;
  for (const key of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = Reflect.get(value, key);
  }
  return value;
}

/** Changes to ignored source data still need publication against prepared runtime facts. */
export function ignoredConfigValuesChanged(
  previous: OpenClawConfig,
  next: OpenClawConfig,
  previousPaths: ConfigFileSnapshot["runtimeIgnoredPaths"],
  nextPaths: ConfigFileSnapshot["runtimeIgnoredPaths"],
): boolean {
  return [...(previousPaths ?? []), ...(nextPaths ?? [])].some(
    (path) => !isDeepStrictEqual(readSourcePath(previous, path), readSourcePath(next, path)),
  );
}

export type GatewayConfigReloadTransactionOwnership = {
  isCurrent: () => boolean;
  checkpoint: () => Promise<void>;
  withRestartPreparation: <T>(
    run: (ownership: GatewayConfigReloadTransactionOwnership) => Promise<T>,
  ) => Promise<T>;
  assertInvokerOwned?: () => void;
  markRuntimeCommitted: (runtimeConfig: OpenClawConfig, plan: GatewayReloadPlan) => void;
  commitRuntimeEnv: () => void;
  publishRuntimeEnv: () => void;
  rollbackRuntimeEnv: () => void;
  reapplyRuntimeOverlays: (config: OpenClawConfig) => OpenClawConfig;
  runtimeIgnoredPaths?: ConfigFileSnapshot["runtimeIgnoredPaths"];
  runtimeEnv?: NonNullable<ConfigWriteNotification["preparedCandidate"]>["runtimeEnv"];
  runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
};

export type InProcessConfigCandidate = {
  config: OpenClawConfig;
  compareConfig: OpenClawConfig;
  persistedHash: string;
  afterWrite?: ConfigWriteNotification["afterWrite"];
  preparedCandidate?: ConfigWriteNotification["preparedCandidate"];
  runtimeRefresh?: RuntimeConfigSnapshotRefreshOptions;
  application?: RuntimeConfigWriteApplicationClaim;
  epoch: number;
  snapshot: ConfigFileSnapshot;
};
