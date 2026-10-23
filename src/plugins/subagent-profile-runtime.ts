import { capturePluginLifecycleAuthority } from "./registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

/** Resolve only in the admitted request's registry; no global or cross-plugin fallback. */
export function captureNativeSubagentProfile(pluginId: string, id: string) {
  const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const record = registry?.plugins.find((entry) => entry.id === pluginId);
  const profile = registry?.subagentProfiles.find(
    (entry) => entry.pluginId === pluginId && entry.id === id,
  );
  if (!registry || !record?.contracts?.subagentProfiles?.includes(id) || !profile) {
    throw new Error(`Unknown or undeclared subagent profile for this plugin: ${id}`);
  }
  const isCurrent = capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
  const assertCurrent = () => {
    if (!isCurrent?.()) {
      throw new Error("Subagent profile plugin is no longer active.");
    }
  };
  assertCurrent();
  return { profile, assertCurrent };
}
