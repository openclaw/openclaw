import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { hasCanonicalPluginDistribution } from "../plugins/plugin-runtime-artifact-binding.js";
import { capturePluginLifecycleAuthority } from "../plugins/registry-lifecycle.js";
import type { PluginRecord, PluginRegistry } from "../plugins/registry.js";
import { getPluginRegistryVersion } from "../plugins/runtime-state.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import { isOpenClawIdPluginVisible } from "../shared/openclaw-id-policy.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
export function getActiveBrowserRegistry(): PluginRegistry | null {
  const registry = getPluginRegistryForContext();
  return registry && capturePluginLifecycleAuthority(registry)?.() ? registry : null;
}

export function browserOwners(registry: PluginRegistry): PluginRecord[] {
  return registry.plugins
    .filter(
      (record) =>
        isOpenClawIdPluginVisible(record.id, getRuntimeConfigSnapshot()) &&
        record.enabled &&
        record.status === "loaded" &&
        record.controlUi &&
        record.controlUi.activation !== "settings-only",
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
}

/** Public decoration decisions only; package provenance comes from the loaded runtime. */
export function enabledLocalPresentations(
  registry = getActiveBrowserRegistry(),
): string[] | undefined {
  return registry
    ? browserOwners(registry)
        .filter(
          (record) =>
            record.controlUi?.activation === "browser-local" &&
            hasCanonicalPluginDistribution(record),
        )
        .map((record) => record.id)
    : undefined;
}

export function createPluginChangePublisher(
  previousRegistry: PluginRegistry,
  broadcast: GatewayBroadcastFn,
) {
  let lastLocal = enabledLocalPresentations(previousRegistry) ?? [];
  return (registry: PluginRegistry) => {
    const next = enabledLocalPresentations(registry) ?? [];
    if (next.length !== lastLocal.length || next.some((id, i) => id !== lastLocal[i])) {
      lastLocal = next;
      broadcast("controlUi.localPresentations.changed", {}, { dropIfSlow: true });
    }
    broadcast(
      "plugins.changed",
      { generation: getPluginRegistryVersion(registry) },
      { dropIfSlow: true },
    );
  };
}
