import { createLegacyBackendProviderRuntime } from "./memory-backend-legacy.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import { hasKind } from "./slots.js";
import type { OpenClawPluginApi } from "./types.js";

/** Memory slot registrars: the owner, the dreaming sidecar, and passive backends. */
export function createMemoryRegistrars(state: PluginRegistryState) {
  const { registry, reportRegistrationError, reportRegistrationWarning } = state;

  const registerMemoryCapability = (
    record: PluginRecord,
    capability: Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0],
  ) => {
    if (!hasKind(record.kind, "memory")) {
      throw new Error("only memory plugins can register a memory capability");
    }
    if (record.memoryBackend === true) {
      // A backend serves only the slot owner's provider runtime; it never joins slot resolution.
      if (capability.providerRuntime) {
        registry.memoryBackends.push({
          pluginId: record.id,
          pluginName: record.name,
          providerRuntime: capability.providerRuntime,
        });
        return;
      }
      if (capability.runtime) {
        // File-shaped runtimes reach the owner through the same adapter the slot uses for them.
        registry.memoryBackends.push({
          pluginId: record.id,
          pluginName: record.name,
          providerRuntime: createLegacyBackendProviderRuntime(record.id, capability.runtime),
          adapter: "legacy",
          instanceOwner: capability.runtime,
        });
        return;
      }
      reportRegistrationWarning(
        record,
        "memory backend registered no memory runtime; the memory slot owner cannot open it",
      );
      return;
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
    registerMemoryCapability,
    registerMemoryPromptSupplement,
    registerMemoryPromptPreparation,
    registerMemoryCorpusSupplement,
  };
}
