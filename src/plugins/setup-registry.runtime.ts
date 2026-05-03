import { createRequire } from "node:module";
import { normalizeProviderId } from "../agents/provider-id.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { isInstalledPluginEnabled } from "./installed-plugin-index.js";
import {
  loadPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";

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

type BundledSetupCliBackendCache = {
  configFingerprint: string;
  entries: SetupCliBackendRuntimeEntry[];
};

let setupRegistryRuntimeModule: SetupRegistryRuntimeModule | null | undefined;
let cachedBundledSetupCliBackends: BundledSetupCliBackendCache | undefined;

export const __testing = {
  resetRuntimeState(): void {
    setupRegistryRuntimeModule = undefined;
    cachedBundledSetupCliBackends = undefined;
  },
  setRuntimeModuleForTest(module: SetupRegistryRuntimeModule | null | undefined): void {
    setupRegistryRuntimeModule = module;
  },
};

function resolveMetadataSnapshotForSetupCliBackends(): {
  snapshot: PluginMetadataSnapshot;
  cacheable: boolean;
} {
  const current = getCurrentPluginMetadataSnapshot({ env: process.env });
  if (current) {
    return { snapshot: current, cacheable: true };
  }
  return {
    snapshot: loadPluginMetadataSnapshot({ config: {}, env: process.env }),
    cacheable: false,
  };
}

function resolveBundledSetupCliBackends(): SetupCliBackendRuntimeEntry[] {
  const { snapshot, cacheable } = resolveMetadataSnapshotForSetupCliBackends();
  const configFingerprint = snapshot.configFingerprint;
  if (
    cacheable &&
    configFingerprint &&
    cachedBundledSetupCliBackends?.configFingerprint === configFingerprint
  ) {
    return cachedBundledSetupCliBackends.entries;
  }
  const entries = snapshot.plugins.flatMap((plugin) => {
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
  if (cacheable && configFingerprint) {
    cachedBundledSetupCliBackends = { configFingerprint, entries };
  }
  return entries;
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
  setupRegistryRuntimeModule = null;
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
