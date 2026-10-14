import type { persistPluginInstall } from "../../plugins/install-persistence.js";
import { metadataSnapshot } from "../../plugins/management-service.test-helpers.js";

/** These command fixtures stub persistence; project only its recorded install arguments. */
export function committedPluginMetadata(
  params: Parameters<typeof persistPluginInstall>[0] | undefined,
) {
  if (!params) {
    throw new Error("Expected plugin persistence before installed metadata inspection");
  }
  return metadataSnapshot({
    id: params.pluginId,
    name: params.pluginId,
    origin: "global",
    enabled: true,
    installRecord: params.install,
  });
}
