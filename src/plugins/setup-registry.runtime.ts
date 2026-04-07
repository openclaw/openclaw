import { createRequire } from "node:module";
import { normalizeProviderId } from "../agents/provider-id.js";
import { BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS } from "./contracts/inventory/bundled-capability-metadata.js";

type SetupRegistryRuntimeModule = Pick<
  typeof import("./setup-registry.js"),
  "resolvePluginSetupCliBackend"
>;

type SetupCliBackendRuntimeEntry = {
  pluginId: string;
  backend: {
    id: string;
  };
};

const require = createRequire(import.meta.url);
const SETUP_REGISTRY_RUNTIME_CANDIDATES = ["./setup-registry.js", "./setup-registry.ts"] as const;

let setupRegistryRuntimeModule: SetupRegistryRuntimeModule | undefined;

const BUNDLED_SETUP_CLI_BACKENDS = BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.flatMap((entry) =>
  entry.cliBackendIds.map(
    (backendId) =>
      ({
        pluginId: entry.pluginId,
        backend: { id: backendId },
      }) satisfies SetupCliBackendRuntimeEntry,
  ),
);

function loadSetupRegistryRuntime(): SetupRegistryRuntimeModule | null {
  if (setupRegistryRuntimeModule) {
    return setupRegistryRuntimeModule;
  }
  for (const candidate of SETUP_REGISTRY_RUNTIME_CANDIDATES) {
    try {
      setupRegistryRuntimeModule = require(candidate) as SetupRegistryRuntimeModule;
      return setupRegistryRuntimeModule;
    } catch {
      // Try source/runtime candidates in order.
    }
  }
  return null;
}

export function resolvePluginSetupCliBackendRuntime(params: { backend: string }) {
  const runtime = loadSetupRegistryRuntime();
  if (runtime) {
    return runtime.resolvePluginSetupCliBackend(params);
  }
  const normalized = normalizeProviderId(params.backend);
  return BUNDLED_SETUP_CLI_BACKENDS.find(
    (entry) => normalizeProviderId(entry.backend.id) === normalized,
  );
}
