import { createRequire } from "node:module";
import { normalizeProviderId } from "../agents/provider-id.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import { loadManifestMetadataSnapshot } from "./manifest-contract-eligibility.js";

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

let setupRegistryRuntimeModule: SetupRegistryRuntimeModule | null | undefined;
// Bundled plugin CLI backends are fixed for the process lifetime (they come
// from the shipped image, not user/workspace config), so memoize them once
// instead of re-deriving on every call. Re-deriving used to call
// loadManifestMetadataSnapshot with an empty config object, which never
// matches the real gateway-owned snapshot's policy hash and forced a full
// synchronous plugin manifest rescan on every isCliProvider() check (e.g.
// once per session row in sessions.list).
let bundledSetupCliBackendsCache: SetupCliBackendRuntimeEntry[] | undefined;

export const __testing = {
  resetRuntimeState(): void {
    setupRegistryRuntimeModule = undefined;
    bundledSetupCliBackendsCache = undefined;
  },
  setRuntimeModuleForTest(module: SetupRegistryRuntimeModule | null | undefined): void {
    setupRegistryRuntimeModule = module;
  },
};

function resolveBundledSetupCliBackends(): SetupCliBackendRuntimeEntry[] {
  if (bundledSetupCliBackendsCache) {
    return bundledSetupCliBackendsCache;
  }
  const snapshot = loadManifestMetadataSnapshot({ config: {}, env: process.env });
  bundledSetupCliBackendsCache = snapshot.plugins.flatMap((plugin) => {
    if (plugin.origin !== "bundled" || !isInstalledPluginEnabled(snapshot.index, plugin.id)) {
      return [];
    }
    return [...plugin.cliBackends, ...(plugin.setup?.cliBackends ?? [])].map(
      (backendId) =>
        ({
          pluginId: plugin.id,
          backend: { id: backendId },
        }) satisfies SetupCliBackendRuntimeEntry,
    );
  });
  return bundledSetupCliBackendsCache;
}

function loadSetupRegistryRuntime(): SetupRegistryRuntimeModule | null {
  if (setupRegistryRuntimeModule !== undefined) {
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
  const normalized = normalizeProviderId(params.backend);
  const runtime = loadSetupRegistryRuntime();
  if (runtime !== null) {
    return runtime.resolvePluginSetupCliBackend(params);
  }
  return resolveBundledSetupCliBackends().find(
    (entry) => normalizeProviderId(entry.backend.id) === normalized,
  );
}
