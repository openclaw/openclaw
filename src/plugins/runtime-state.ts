import type { PluginInstanceAdmission } from "./plugin-instance.types.js";
import { PLUGIN_REGISTRY_STATE } from "./runtime-state-key.js";
// Stores plugin runtime registry state for the current process lifecycle.
import { getActivePluginRegistryWorkspaceDirFromStateCore } from "./runtime-workspace-state.js";

export { PLUGIN_REGISTRY_STATE };

type PluginRegistry = import("./registry-types.js").PluginRegistry;
type MemoryCapabilityRegistrar = import("./types.js").OpenClawPluginApi["registerMemoryCapability"];

export type RegistryState = {
  activeRegistry: PluginRegistry | null;
  activeVersion: number;
  registryVersions?: WeakMap<PluginRegistry, number>;
  agentEventBridgeUnsubscribe?: (() => void) | undefined;
  key: string | null;
  workspaceDir: string | null;
  runtimeSubagentMode: "default" | "explicit" | "gateway-bindable";
  importedPluginIds: Set<string>;
  registrationContext?: {
    registry: PluginRegistry;
    pluginId: string;
    instance?: PluginInstanceAdmission;
    registerMemoryCapability?: MemoryCapabilityRegistrar;
  };
  commandRegistryClearTail?: Promise<void>;
  commandRegistryClearRegistries?: Map<PluginRegistry, number>;
  retiredRegistryCleanups?: Map<
    Promise<void>,
    { registry: PluginRegistry; work: import("../shared/async-work-scope.js").AsyncWorkScope }
  >;
};

type GlobalRegistryState = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: RegistryState;
};

export function getPluginRegistryState(): RegistryState | undefined {
  return (globalThis as GlobalRegistryState)[PLUGIN_REGISTRY_STATE];
}

/** Publication provenance follows the selected registry, including retained request snapshots. */
export function getPluginRegistryVersion(registry: PluginRegistry | null): number | undefined {
  return registry ? getPluginRegistryState()?.registryVersions?.get(registry) : undefined;
}

/** Policy reads the process-active registry, independently of request or registration scopes. */
export function getActivePluginGatewayNodePolicyRegistry(): PluginRegistry | null {
  return getPluginRegistryState()?.activeRegistry ?? null;
}

export function getActivePluginRegistryWorkspaceDirFromState(): string | undefined {
  return getActivePluginRegistryWorkspaceDirFromStateCore();
}
