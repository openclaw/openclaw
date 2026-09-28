// Pure plugin config cleanup shared by doctor repair and full uninstall flows.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  mergePluginConfigUninstallActions,
  removePluginInstallOwnerFromConfig,
  removePluginRuntimePolicyFromConfig,
} from "./uninstall-package-config.js";
import type { PluginConfigUninstallActions } from "./uninstall-package-config.js";

export {
  isUninstallPathInsideOrEqual,
  resolveComparableUninstallPath,
  resolveUninstallChannelConfigKeys,
  type PluginConfigUninstallActions,
} from "./uninstall-package-config.js";

/** Remove plugin references from config without loading uninstall process/runtime dependencies. */
export function removePluginFromConfig(
  cfg: OpenClawConfig,
  pluginId: string,
  opts?: { channelIds?: string[] },
): { config: OpenClawConfig; actions: PluginConfigUninstallActions } {
  const hasInstallRecord = Object.hasOwn(cfg.plugins?.installs ?? {}, pluginId);
  const policy = removePluginRuntimePolicyFromConfig(cfg, pluginId, {
    ...(hasInstallRecord ? opts : { channelIds: [] }),
  });
  const owner = removePluginInstallOwnerFromConfig(policy.config, pluginId);
  return {
    config: owner.config,
    actions: mergePluginConfigUninstallActions(policy.actions, owner.actions),
  };
}
