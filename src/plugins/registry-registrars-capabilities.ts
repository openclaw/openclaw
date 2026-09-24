import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { registerContextEngineInRegistry } from "../context-engine/registry.js";
import { DecisionProviderHost } from "../decisions/provider-host.js";
import { registerPluginInteractiveHandlerInRegistry } from "./interactive-registry.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import { defaultSlotIdForKey } from "./slots.js";
import type { OpenClawPluginApi, PluginRegistrationMode } from "./types.js";

export function createCapabilityRegistrars(state: PluginRegistryState) {
  const { registry, reportRegistrationError, reportRegistrationWarning } = state;

  const registerDecisionProvider = (
    record: PluginRecord,
    provider: Parameters<OpenClawPluginApi["registerDecisionProvider"]>[0],
  ) => {
    const id = normalizeOptionalString(provider?.id);
    if (
      !id ||
      id !== provider.id ||
      id.includes("/") ||
      provider.contractVersion !== 1 ||
      typeof provider.evaluate !== "function" ||
      (provider.isReady !== undefined && typeof provider.isReady !== "function")
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
    if (registry.decisionProviders.some((entry) => entry.host.provider.id === id)) {
      reportRegistrationError(record, `decision provider already registered: ${id}`);
      return;
    }
    const host = new DecisionProviderHost(provider, record);
    registry.decisionProviders.push({ pluginId: record.id, host });
    record.services.push(`decisions:${id}`);
    getPluginInstance(record)?.lifecycle.onDispose(() => host.stop());
    // The service is a physical-settlement owner. Reload also closes admission
    // before earlier sidecar and memory drains can wait on decision work.
    registry.services.push({
      pluginId: record.id,
      id: `decisions:${id}`,
      origin: record.origin,
      source: record.source,
      service: { id: `decisions:${id}`, start() {}, stop: () => host.stop() },
    });
  };

  const registerDetachedTaskRuntime = (
    record: PluginRecord,
    runtime: Parameters<OpenClawPluginApi["registerDetachedTaskRuntime"]>[0],
  ) => {
    const existing = registry.detachedTaskRuntimes[0];
    if (existing && existing.pluginId !== record.id) {
      reportRegistrationError(
        record,
        `detached task runtime already registered by ${existing.pluginId}`,
      );
      return;
    }
    const next = { pluginId: record.id, runtime };
    if (existing) {
      registry.detachedTaskRuntimes.splice(0, 1, next);
    } else {
      registry.detachedTaskRuntimes.push(next);
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
    const id = normalizeOptionalString(
      (provider as Partial<Parameters<OpenClawPluginApi["registerCompactionProvider"]>[0]> | null)
        ?.id,
    );
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

  return {
    registerDecisionProvider,
    registerDetachedTaskRuntime,
    registerInteractiveHandler,
    registerContextEngine,
    registerCompactionProvider,
  };
}
