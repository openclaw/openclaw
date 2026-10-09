import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { PluginRegistry } from "./registry-types.js";

export type PluginRegistryInspectionTransferTarget = {
  transferRegistrationTo(pluginId: string, target: PluginRegistryInspectionTransferTarget): void;
};

// Shared by runtime/built SDK graphs without importing inspection disposal into instance scope.
const inspectionTransferTargets = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginRegistryInspectionTransferTargets"),
  () => new WeakMap<PluginRegistry, PluginRegistryInspectionTransferTarget>(),
);

export function bindPluginRegistryInspectionTransferTarget(
  registry: PluginRegistry,
  target: PluginRegistryInspectionTransferTarget,
): void {
  inspectionTransferTargets.set(registry, target);
}

export function getPluginRegistryInspectionTransferTarget(
  registry: PluginRegistry,
): PluginRegistryInspectionTransferTarget | undefined {
  return inspectionTransferTargets.get(registry);
}
