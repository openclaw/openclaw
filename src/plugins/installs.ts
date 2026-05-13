import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { buildNpmResolutionFields, type NpmSpecResolution } from "../infra/install-source-utils.js";

export type PluginInstallUpdate = PluginInstallRecord & { pluginId: string };

export function recordPluginInstallInRecordMap(
  records: Record<string, PluginInstallRecord>,
  update: PluginInstallUpdate,
): Record<string, PluginInstallRecord> {
  const { pluginId, ...record } = update;
  return {
    ...records,
    [pluginId]: {
      ...records[pluginId],
      ...record,
      installedAt: record.installedAt ?? new Date().toISOString(),
    },
  };
}

export function buildNpmResolutionInstallFields(
  resolution?: NpmSpecResolution,
): Pick<
  PluginInstallRecord,
  "resolvedName" | "resolvedVersion" | "resolvedSpec" | "integrity" | "shasum" | "resolvedAt"
> {
  return buildNpmResolutionFields(resolution);
}

export function recordPluginInstall(
  cfg: OpenClawConfig,
  update: PluginInstallUpdate,
): OpenClawConfig {
  const installs = recordPluginInstallInRecordMap(cfg.plugins?.installs ?? {}, update);

  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      installs,
    },
  };
}
