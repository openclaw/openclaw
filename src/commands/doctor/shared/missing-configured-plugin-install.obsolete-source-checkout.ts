import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { isPathInside } from "../../../infra/path-guards.js";
import {
  listObsoleteSourceCheckoutPluginInstallRecords,
  type ObsoleteSourceCheckoutPluginInstallRecord,
} from "../../../plugins/stale-local-bundled-plugin-install-records.js";

/** A configured plugin still recorded at an abandoned source-checkout copy. */
export type ObsoleteSourceCheckoutInstall = {
  checkoutPluginDir: string;
  candidate: ObsoleteSourceCheckoutPluginInstallRecord["official"] & {
    pluginId: string;
    trustedSourceLinkedOfficialInstall: true;
    versionBoundToOpenClaw: true;
  };
};

export function collectObsoleteSourceCheckoutInstalls(params: {
  records: Record<string, PluginInstallRecord>;
  currentBundledPluginIds: ReadonlySet<string>;
  loadPaths: readonly string[];
  env: NodeJS.ProcessEnv;
  isRepairTarget: (pluginId: string) => boolean;
  resolvePathIdentity: (value: string) => string;
}): ReadonlyMap<string, ObsoleteSourceCheckoutInstall> {
  // The configured load paths, not discovery, decide whether the operator still selects a checkout copy.
  const loadPathIdentities = params.loadPaths
    .filter((value) => value.trim())
    .map(params.resolvePathIdentity);
  const installs = new Map<string, ObsoleteSourceCheckoutInstall>();
  for (const {
    pluginId,
    checkoutPluginDir,
    official,
  } of listObsoleteSourceCheckoutPluginInstallRecords({
    installRecords: params.records,
    currentBundledPluginIds: params.currentBundledPluginIds,
    env: params.env,
  })) {
    const checkoutIdentity = params.resolvePathIdentity(checkoutPluginDir);
    if (
      !params.isRepairTarget(pluginId) ||
      loadPathIdentities.some(
        (loadPath) =>
          isPathInside(loadPath, checkoutIdentity) || isPathInside(checkoutIdentity, loadPath),
      )
    ) {
      continue;
    }
    installs.set(pluginId, {
      checkoutPluginDir,
      candidate: {
        pluginId,
        ...official,
        trustedSourceLinkedOfficialInstall: true,
        versionBoundToOpenClaw: true,
      },
    });
  }
  return installs;
}
