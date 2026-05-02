import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";

export {
  fingerprintPluginControlPlaneContext,
  fingerprintPluginDiscoveryContext,
  resolvePluginControlPlaneContext,
  resolvePluginControlPlaneFingerprint,
  resolvePluginDiscoveryContext,
  resolvePluginDiscoveryFingerprint,
} from "./plugin-control-plane-context.js";

export function resolvePluginMetadataSnapshotConfigFingerprint(
  config: OpenClawConfig | undefined,
  options: {
    activationFingerprint?: string;
    env?: NodeJS.ProcessEnv;
    index?: InstalledPluginIndex;
    inventoryFingerprint?: string;
    policyHash?: string;
    workspaceDir?: string;
  } = {},
): string {
  return resolvePluginControlPlaneFingerprint({
    config,
    activationFingerprint: options.activationFingerprint,
    env: options.env,
    index: options.index,
    inventoryFingerprint: options.inventoryFingerprint,
    policyHash: options.policyHash,
    workspaceDir: options.workspaceDir,
  });
}
