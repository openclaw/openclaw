// Keep plugin removal separate from persistent mutation plumbing.
import { projectDefaultInferenceRoute } from "./inference-route.js";

/**
 * Uninstalling the plugin that provides the active default inference route
 * would break the very session driving the change, so that case stays a
 * terminal-only operation. Every other plugin is uninstallable behind the
 * standard approval gate — matching what the operator can do from the UI/CLI.
 */
export async function isPluginBackingDefaultInferenceRoute(pluginId: string): Promise<boolean> {
  const { readConfigFileSnapshot } = await import("../config/config.js");
  const snapshot = await readConfigFileSnapshot();
  if (!snapshot.exists || !snapshot.valid) {
    return true;
  }
  const config = snapshot.runtimeConfig ?? snapshot.config;
  const route = (await projectDefaultInferenceRoute(config ?? {})).route;
  if (!route) {
    return false;
  }
  // The route's execution owners are the provider plus whichever runtime
  // component executes it (embedded harness override or the resolved model
  // runtime policy, e.g. a CLI-backend harness plugin) — removing any of them
  // breaks the session driving this change.
  const { resolveModelRuntimePolicy } = await import("../agents/model-runtime-policy.js");
  const runtimePolicyId = resolveModelRuntimePolicy({
    config,
    provider: route.provider,
    modelId: route.model,
    agentId: route.agentId,
  }).policy?.id;
  const normalizedPluginId = pluginId.trim().toLowerCase();
  const components = [
    route.provider,
    runtimePolicyId,
    route.runner === "embedded" ? route.agentHarnessRuntimeOverride : undefined,
  ]
    .map((component) => component?.trim().toLowerCase())
    .filter((component): component is string => Boolean(component));
  // Same-name convention covers components with no resolvable plugin metadata.
  if (components.includes(normalizedPluginId)) {
    return true;
  }
  const { resolveOwningPluginIdsForProviderRef } = await import("../plugins/providers.js");
  return components.some((component) =>
    (resolveOwningPluginIdsForProviderRef({ provider: component, config }) ?? []).some(
      (owner) => owner.trim().toLowerCase() === normalizedPluginId,
    ),
  );
}
