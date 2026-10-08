import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { registerContextEngineInRegistry } from "../context-engine/registry.js";
import { resolveConfiguredDecisionProvider } from "../decisions/configured-providers.js";
import { DecisionProviderHost } from "../decisions/provider-host.js";
import { registerPluginInteractiveHandlerInRegistry } from "./interactive-registry.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createHostRegistrars } from "./registry-registrars-host.js";
import { createNetworkRegistrars } from "./registry-registrars-network.js";
import { createOperationRegistrars } from "./registry-registrars-operations.js";
import { createProviderRegistrars } from "./registry-registrars-providers.js";
import { createToolHookRegistrars } from "./registry-registrars-tools-hooks.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import { defaultSlotIdForKey, hasKind } from "./slots.js";
import type { OpenClawPluginApi, PluginRegistrationMode } from "./types.js";

/** Compose domain registrars over one explicit mutable registry state. */
export function createPluginRegistrars(state: PluginRegistryState) {
  const { registry, reportRegistrationError, reportRegistrationWarning } = state;
  // Reserve adapter identities independently of aliases, including during factory construction.
  const decisionAdapterIds = new Set<string>();

  const registerDecisionProvider = (
    record: PluginRecord,
    provider: Parameters<OpenClawPluginApi["registerDecisionProvider"]>[0],
    config: OpenClawPluginApi["config"],
  ) => {
    const id = normalizeOptionalString(provider?.id);
    if (
      !id ||
      id !== provider.id ||
      id.includes("/") ||
      provider.contractVersion !== 1 ||
      typeof provider.evaluate !== "function" ||
      (provider.isReady !== undefined && typeof provider.isReady !== "function") ||
      (provider.createConfiguredProvider !== undefined &&
        typeof provider.createConfiguredProvider !== "function")
    ) {
      reportRegistrationError(record, "invalid version 1 decision provider contract");
      return;
    }
    if (!record.contracts?.decisionProviders?.includes(id)) {
      reportRegistrationError(
        record,
        "decision provider must declare contracts.decisionProviders ownership",
      );
      return;
    }
    if (decisionAdapterIds.has(id)) {
      reportRegistrationError(record, `decision provider already registered: ${id}`);
      return;
    }
    decisionAdapterIds.add(id);
    const registerHost = (bound: typeof provider, configuredAdapterId?: string) => {
      if (registry.decisionProviders.some((entry) => entry.host.provider.id === bound.id)) {
        reportRegistrationError(record, `decision provider already registered: ${bound.id}`);
        return;
      }
      const host = new DecisionProviderHost(bound, record, configuredAdapterId);
      registry.decisionProviders.push({ pluginId: record.id, host });
      record.services.push(`decisions:${bound.id}`);
      getPluginInstance(record)?.lifecycle.onDispose(() => host.stop());
      // All configured aliases retain the declaring plugin's physical-settlement owner.
      registry.services.push({
        pluginId: record.id,
        id: `decisions:${bound.id}`,
        origin: record.origin,
        source: record.source,
        service: { id: `decisions:${bound.id}`, start() {}, stop: () => host.stop() },
      });
    };
    const readConfig = () => state.registryParams.runtime.config?.current() ?? config;
    if (!resolveConfiguredDecisionProvider(config, id)) {
      registerHost(provider);
    }
    if (!provider.createConfiguredProvider) {
      return;
    }
    for (const [key, configured] of Object.entries(config.models?.providers ?? {})) {
      if (configured.type !== "decision" || configured.decisionProvider !== id) {
        continue;
      }
      const configuredId = normalizeProviderId(key);
      try {
        const bound = provider.createConfiguredProvider({
          id: configuredId,
          getConfig: () => {
            const current = readConfig();
            const entry = current && resolveConfiguredDecisionProvider(current, configuredId);
            return entry?.decisionProvider === id ? entry : undefined;
          },
        });
        if (
          bound?.id !== configuredId ||
          bound.contractVersion !== 1 ||
          typeof bound.evaluate !== "function" ||
          (bound.isReady !== undefined && typeof bound.isReady !== "function")
        ) {
          reportRegistrationError(record, "invalid configured decision provider contract");
          continue;
        }
        registerHost(bound, id);
      } catch {
        reportRegistrationError(record, "configured decision provider construction failed");
      }
    }
  };

  const registerInteractiveHandler = (
    record: PluginRecord,
    registration: Parameters<OpenClawPluginApi["registerInteractiveHandler"]>[0],
  ) => {
    const result = registerPluginInteractiveHandlerInRegistry(registry, record.id, registration, {
      pluginName: record.name,
      pluginRoot: record.rootDir,
    });
    if (!result.ok) {
      reportRegistrationWarning(record, result.error ?? "interactive handler registration failed");
    }
  };

  const registerContextEngine = (
    record: PluginRecord,
    id: Parameters<OpenClawPluginApi["registerContextEngine"]>[0],
    factory: Parameters<OpenClawPluginApi["registerContextEngine"]>[1],
    registrationMode: PluginRegistrationMode,
  ) => {
    const normalizedId = normalizeOptionalString(id) ?? "";
    if (!normalizedId) {
      reportRegistrationError(record, "context engine registration missing id");
      return;
    }
    if (typeof factory !== "function") {
      reportRegistrationError(
        record,
        `context engine "${normalizedId}" registration missing factory`,
      );
      return;
    }
    if (normalizedId === defaultSlotIdForKey("contextEngine")) {
      reportRegistrationError(record, `context engine id reserved by core: ${normalizedId}`);
      return;
    }
    getPluginInstance(record)?.admitFactory(factory);
    const result = registerContextEngineInRegistry(
      registry,
      normalizedId,
      factory,
      `plugin:${record.id}`,
      {
        allowSameOwnerRefresh: true,
        lifecycle: registrationMode === "full" ? "runtime" : "readOnlyDiscovery",
      },
    );
    if (!result.ok) {
      reportRegistrationError(
        record,
        `context engine already registered: ${normalizedId} (${result.existingOwner})`,
      );
      return;
    }
    if (!record.contextEngineIds?.includes(normalizedId)) {
      record.contextEngineIds = [...(record.contextEngineIds ?? []), normalizedId];
    }
  };

  const registerCompactionProvider = (
    record: PluginRecord,
    provider: Parameters<OpenClawPluginApi["registerCompactionProvider"]>[0],
  ) => {
    const id = normalizeOptionalString(provider?.id);
    if (!id) {
      reportRegistrationError(record, "compaction provider registration missing id");
      return;
    }
    if (typeof provider?.summarize !== "function") {
      reportRegistrationError(record, `compaction provider "${id}" registration missing summarize`);
      return;
    }
    const existing = registry.compactionProviders.find((entry) => entry.provider.id === id);
    if (existing) {
      const ownerDetail = existing.ownerPluginId ? ` (owner: ${existing.ownerPluginId})` : "";
      reportRegistrationError(
        record,
        `compaction provider already registered: ${id}${ownerDetail}`,
      );
      return;
    }
    registry.compactionProviders.push({ provider, ownerPluginId: record.id });
  };

  const registerMemoryCapability = (
    record: PluginRecord,
    capability: Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0],
  ) => {
    if (!hasKind(record.kind, "memory")) {
      throw new Error("only memory plugins can register a memory capability");
    }
    if (Array.isArray(record.kind) && record.kind.length > 1 && !record.memorySlotSelected) {
      reportRegistrationWarning(
        record,
        "dual-kind plugin not selected for memory slot; skipping memory capability registration",
      );
      return;
    }
    // Dreaming keeps an unselected sidecar active for consolidation. Strip its
    // slot-owner fields so resolution cannot lend its runtime or recall grant.
    const memorySlotSelected = record.memorySlotSelected === true;
    const dropsSlotOwnerFacts =
      !memorySlotSelected &&
      (capability.runtime !== undefined ||
        capability.providerRuntime !== undefined ||
        capability.recallToolNames !== undefined ||
        capability.deterministicRecallToolName !== undefined ||
        capability.supportsPrivateTranscriptRecall !== undefined);
    if (dropsSlotOwnerFacts) {
      reportRegistrationWarning(
        record,
        "memory plugin not selected for the memory slot; skipping its indexing runtime and recall registration (consolidation lifecycle preserved)",
      );
    }
    const {
      runtime: _droppedRuntime,
      providerRuntime: _droppedProviderRuntime,
      recallToolNames: _droppedRecallToolNames,
      deterministicRecallToolName: _droppedRecallToolName,
      supportsPrivateTranscriptRecall: _droppedPrivateRecall,
      ...consolidationCapability
    } = capability;
    if (memorySlotSelected && capability.runtime) {
      // oxlint-disable-next-line typescript/unbound-method -- Record factory identity; executable views bind the original receiver.
      getPluginInstance(record)?.admitFactory(capability.runtime.getMemorySearchManager);
    }
    registry.memoryCapabilities.push({
      pluginId: record.id,
      capability: memorySlotSelected ? capability : consolidationCapability,
      memorySlotSelected,
    });
  };

  const registerMemoryPromptSupplement = (
    record: PluginRecord,
    builder: Parameters<OpenClawPluginApi["registerMemoryPromptSupplement"]>[0],
  ) => {
    if (typeof builder !== "function") {
      reportRegistrationError(record, "memory prompt supplement registration missing builder");
      return;
    }
    registry.memoryPromptSupplements = registry.memoryPromptSupplements.filter(
      (entry) => entry.pluginId !== record.id,
    );
    registry.memoryPromptSupplements.push({ pluginId: record.id, builder });
  };

  const registerMemoryPromptPreparation = (
    record: PluginRecord,
    prepare: Parameters<OpenClawPluginApi["registerMemoryPromptPreparation"]>[0],
  ) => {
    if (typeof prepare !== "function") {
      reportRegistrationError(
        record,
        "memory prompt preparation registration missing prepare function",
      );
      return;
    }
    registry.memoryPromptPreparations = registry.memoryPromptPreparations.filter(
      (entry) => entry.pluginId !== record.id,
    );
    registry.memoryPromptPreparations.push({ pluginId: record.id, prepare });
  };

  const registerMemoryCorpusSupplement = (
    record: PluginRecord,
    supplement: Parameters<OpenClawPluginApi["registerMemoryCorpusSupplement"]>[0],
  ) => {
    registry.memoryCorpusSupplements = registry.memoryCorpusSupplements.filter(
      (entry) => entry.pluginId !== record.id,
    );
    registry.memoryCorpusSupplements.push({ pluginId: record.id, supplement });
  };

  return {
    registerDecisionProvider,
    registerInteractiveHandler,
    registerContextEngine,
    registerCompactionProvider,
    ...createToolHookRegistrars(state),
    ...createNetworkRegistrars(state),
    ...createProviderRegistrars(state),
    ...createOperationRegistrars(state),
    ...createHostRegistrars(state),
    registerMemoryCapability,
    registerMemoryPromptSupplement,
    registerMemoryPromptPreparation,
    registerMemoryCorpusSupplement,
    registerModelCatalogProvider: state.registerModelCatalogProvider,
  };
}

export type PluginRegistrars = ReturnType<typeof createPluginRegistrars>;
