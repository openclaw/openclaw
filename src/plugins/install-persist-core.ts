import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { enablePluginInConfig } from "./enable.js";
import {
  recordPluginInstallInRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import type { PluginInstallUpdate } from "./installs.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";

export type PluginInstallPersistState = {
  config: OpenClawConfig;
  installRecords: Record<string, PluginInstallRecord>;
  warnings: string[];
};

type SlotSelection = (
  config: OpenClawConfig,
  pluginId: string,
) =>
  | {
      config: OpenClawConfig;
      warnings: string[];
    }
  | Promise<{
      config: OpenClawConfig;
      warnings: string[];
    }>;

export function addInstalledPluginToAllowlist(
  cfg: OpenClawConfig,
  pluginId: string,
): OpenClawConfig {
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.length === 0 || allow.includes(pluginId)) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, pluginId].toSorted(),
    },
  };
}

export function removeInstalledPluginFromDenylist(
  cfg: OpenClawConfig,
  pluginId: string,
): OpenClawConfig {
  const deny = cfg.plugins?.deny;
  if (!Array.isArray(deny) || !deny.includes(pluginId)) {
    return cfg;
  }
  const nextDeny = deny.filter((id) => id !== pluginId);
  const plugins = {
    ...cfg.plugins,
    ...(nextDeny.length > 0 ? { deny: nextDeny } : {}),
  };
  if (nextDeny.length === 0) {
    delete plugins.deny;
  }
  return {
    ...cfg,
    plugins,
  };
}

export async function buildPluginInstallPersistState(params: {
  config: OpenClawConfig;
  pluginId: string;
  install: Omit<PluginInstallUpdate, "pluginId">;
  installRecords: Record<string, PluginInstallRecord>;
  enable?: boolean;
  applySlotSelection?: SlotSelection;
}): Promise<PluginInstallPersistState> {
  const installConfig =
    params.enable === false
      ? params.config
      : removeInstalledPluginFromDenylist(
          addInstalledPluginToAllowlist(params.config, params.pluginId),
          params.pluginId,
        );
  const enableResult =
    params.enable === false
      ? null
      : enablePluginInConfig(installConfig, params.pluginId, {
          updateChannelConfig: false,
        });
  const enabledConfig = enableResult?.config ?? installConfig;
  const slotResult =
    params.enable === false
      ? { config: enabledConfig, warnings: [] }
      : await (params.applySlotSelection ?? applySlotSelectionForPlugin)(
          enabledConfig,
          params.pluginId,
        );
  return {
    config: withoutPluginInstallRecords(slotResult.config),
    installRecords: recordPluginInstallInRecords(params.installRecords, {
      pluginId: params.pluginId,
      ...params.install,
    }),
    warnings: [
      ...slotResult.warnings,
      ...(enableResult === null || enableResult.enabled
        ? []
        : [
            `Plugin "${params.pluginId}" could not be enabled (${enableResult.reason ?? "unknown reason"}).`,
          ]),
    ],
  };
}
