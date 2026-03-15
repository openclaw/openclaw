import type { OpenClawConfig } from "../config/config.js";
import type { PluginCandidate } from "../plugins/discovery.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginRecord, PluginRegistry } from "../plugins/registry.js";
import type { OpenClawPluginApi, OpenClawPluginModule, PluginLogger } from "../plugins/types.js";
import { finalizeExtensionHostRegistryLoad } from "./loader-finalize.js";
import { processExtensionHostPluginCandidate } from "./loader-flow.js";
import type { ExtensionHostProvenanceIndex } from "./loader-policy.js";

export type ExtensionHostLoaderSession = {
  registry: PluginRegistry;
  logger: PluginLogger;
  env: NodeJS.ProcessEnv;
  provenance: ExtensionHostProvenanceIndex;
  cacheEnabled: boolean;
  cacheKey: string;
  memorySlot?: string | null;
  seenIds: Map<string, PluginRecord["origin"]>;
  selectedMemoryPluginId: string | null;
  memorySlotMatched: boolean;
  setCachedRegistry: (cacheKey: string, registry: PluginRegistry) => void;
  activateRegistry: (registry: PluginRegistry, cacheKey: string) => void;
};

export function createExtensionHostLoaderSession(params: {
  registry: PluginRegistry;
  logger: PluginLogger;
  env: NodeJS.ProcessEnv;
  provenance: ExtensionHostProvenanceIndex;
  cacheEnabled: boolean;
  cacheKey: string;
  memorySlot?: string | null;
  setCachedRegistry: (cacheKey: string, registry: PluginRegistry) => void;
  activateRegistry: (registry: PluginRegistry, cacheKey: string) => void;
}): ExtensionHostLoaderSession {
  return {
    registry: params.registry,
    logger: params.logger,
    env: params.env,
    provenance: params.provenance,
    cacheEnabled: params.cacheEnabled,
    cacheKey: params.cacheKey,
    memorySlot: params.memorySlot,
    seenIds: new Map(),
    selectedMemoryPluginId: null,
    memorySlotMatched: false,
    setCachedRegistry: params.setCachedRegistry,
    activateRegistry: params.activateRegistry,
  };
}

export function processExtensionHostLoaderSessionCandidate(params: {
  session: ExtensionHostLoaderSession;
  candidate: PluginCandidate;
  manifestRecord: PluginManifestRecord;
  normalizedConfig: {
    entries: Record<
      string,
      {
        enabled?: boolean;
        hooks?: {
          allowPromptInjection?: boolean;
        };
        config?: unknown;
      }
    >;
    slots: {
      memory?: string | null;
    };
  };
  rootConfig: OpenClawConfig;
  validateOnly: boolean;
  createApi: (
    record: PluginRecord,
    options: {
      config: OpenClawConfig;
      pluginConfig?: Record<string, unknown>;
      hookPolicy?: { allowPromptInjection?: boolean };
    },
  ) => OpenClawPluginApi;
  loadModule: (safeSource: string) => OpenClawPluginModule;
}): void {
  const processed = processExtensionHostPluginCandidate({
    candidate: params.candidate,
    manifestRecord: params.manifestRecord,
    normalizedConfig: params.normalizedConfig,
    rootConfig: params.rootConfig,
    validateOnly: params.validateOnly,
    logger: params.session.logger,
    registry: params.session.registry,
    seenIds: params.session.seenIds,
    selectedMemoryPluginId: params.session.selectedMemoryPluginId,
    createApi: params.createApi,
    loadModule: params.loadModule,
  });
  params.session.selectedMemoryPluginId = processed.selectedMemoryPluginId;
  params.session.memorySlotMatched ||= processed.memorySlotMatched;
}

export function finalizeExtensionHostLoaderSession(
  session: ExtensionHostLoaderSession,
): PluginRegistry {
  return finalizeExtensionHostRegistryLoad({
    registry: session.registry,
    memorySlot: session.memorySlot,
    memorySlotMatched: session.memorySlotMatched,
    provenance: session.provenance,
    logger: session.logger,
    env: session.env,
    cacheEnabled: session.cacheEnabled,
    cacheKey: session.cacheKey,
    setCachedRegistry: session.setCachedRegistry,
    activateRegistry: session.activateRegistry,
  });
}
