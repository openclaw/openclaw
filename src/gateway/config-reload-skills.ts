import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";

export async function refreshConfigReloadSkills(config: OpenClawConfig): Promise<void> {
  const { refreshSkillsDiscovery } = await import("../skills/runtime/refresh.js");
  await refreshSkillsDiscovery({
    config,
    reason: "config-change",
    pluginMetadataSnapshot: getProcessGatewayPluginMetadataSnapshot(),
  });
}
