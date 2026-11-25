import { isDeepStrictEqual } from "node:util";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import { loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";

/** Recheck staged enablement at its config writer, after any intervening plugin update. */
export async function assertPluginConfigActivationConsent(params: {
  nextConfig: OpenClawConfig;
  previousInstallRecords?: Record<string, PluginInstallRecord>;
  nextInstallRecords?: Record<string, PluginInstallRecord>;
}): Promise<void> {
  const records = params.nextInstallRecords ?? (await loadInstalledPluginIndexInstallRecords());
  if (Object.keys(records).length === 0) {
    return;
  }
  const { resolvePluginMetadataSnapshot } = await import("./plugin-metadata-snapshot.js");
  const { resolvePluginCapabilityConsent } = await import("./capability-consent.js");
  const { resolvePluginControlPlaneWorkspace } = await import("./control-plane-workspace.js");
  const snapshot = await readConfigFileSnapshot();
  const metadataForConfig = (config: OpenClawConfig) =>
    resolvePluginMetadataSnapshot({
      config,
      allowCurrent: false,
      workspaceDir: resolvePluginControlPlaneWorkspace({ config }).workspaceDir,
    });
  const previous = metadataForConfig(snapshot.config);
  const next = metadataForConfig(params.nextConfig);
  const previouslyEnabled = new Set(
    previous.index.plugins
      .filter((plugin) => snapshot.valid && plugin.enabled)
      .map((plugin) => plugin.pluginId),
  );
  for (const plugin of next.index.plugins) {
    if (!plugin.enabled || plugin.origin === "bundled") {
      continue;
    }
    const owner = resolveInstalledPluginIndexInstallOwner(plugin) ?? plugin.pluginId;
    const record = records[owner];
    const previousRecord = params.previousInstallRecords?.[owner];
    const replaced =
      params.previousInstallRecords !== undefined &&
      (!previousRecord || record?.acceptedSurface !== undefined) &&
      !isDeepStrictEqual(previousRecord, record);
    // Metadata refreshes do not retroactively require consent from a running legacy install.
    if (replaced || !previouslyEnabled.has(plugin.pluginId)) {
      await resolvePluginCapabilityConsent({
        config: params.nextConfig,
        pluginId: plugin.pluginId,
        metadata: next,
      });
    }
  }
}
