/** Test-only controls for plugin doctor contract loading. */
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";

export function clearPluginDoctorContractRegistryCache(): void {
  clearPluginMetadataLifecycleCaches();
}
