import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { formatErrorMessage } from "../infra/errors.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import type { InstalledPluginIndexRefreshReason } from "./installed-plugin-index.js";
import { tracePluginLifecyclePhaseAsync } from "./plugin-lifecycle-trace.js";
import { refreshPluginRegistry } from "./plugin-registry.js";

export type PluginRegistryRefreshLogger = {
  warn?: (message: string) => void;
};

export type PluginRegistryRefreshTrace = <T>(
  phase: string,
  fn: () => Promise<T>,
  details?: Record<string, boolean | number | string | undefined>,
) => Promise<T>;

const defaultPluginRegistryRefreshTrace: PluginRegistryRefreshTrace = async (phase, fn, details) =>
  await tracePluginLifecyclePhaseAsync(phase, fn, details);

export async function refreshPluginRegistryAfterConfigMutation(params: {
  config: OpenClawConfig;
  reason: InstalledPluginIndexRefreshReason;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  installRecords?: Record<string, PluginInstallRecord>;
  traceCommand?: string;
  trace?: PluginRegistryRefreshTrace;
  logger?: PluginRegistryRefreshLogger;
}): Promise<string[]> {
  const trace = params.trace ?? defaultPluginRegistryRefreshTrace;
  try {
    const installRecords =
      params.installRecords ??
      (await trace(
        "install records load",
        () => loadInstalledPluginIndexInstallRecords(params.env ? { env: params.env } : {}),
        { command: params.traceCommand ?? "registry-refresh" },
      ));
    await trace(
      "registry refresh",
      () =>
        refreshPluginRegistry({
          config: params.config,
          reason: params.reason,
          installRecords,
          ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
          ...(params.env ? { env: params.env } : {}),
        }),
      { command: params.traceCommand ?? "registry-refresh", reason: params.reason },
    );
    return [];
  } catch (error) {
    const message = `Plugin registry refresh failed: ${formatErrorMessage(error)}`;
    params.logger?.warn?.(message);
    return [message];
  }
}
