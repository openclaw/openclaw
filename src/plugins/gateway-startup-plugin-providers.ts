// Collects configured model, generation, voice, and memory provider ownership.
import { listModelRefsFromConfigValue } from "@openclaw/model-catalog-core/configured-model-refs";
import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries, listAgentIds } from "../agents/agent-scope-config.js";
import { resolveConfiguredRuntimePluginSelections } from "../agents/configured-runtime-plugin-selections.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../agents/model-selection-resolve.js";
import { readUtilityModelSetting } from "../agents/utility-model-setting.js";
import { resolveConfiguredTalkRealtimeProviderId } from "../config/talk.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveConfiguredGenericEmbeddingProviderId } from "./embedding-provider-config.js";
import { listRegisteredEmbeddingProviders } from "./embedding-providers.js";
import type {
  ConfiguredGenerationProviderIds,
  ConfiguredVoiceProviderIds,
} from "./gateway-startup-plugin-contracts.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginRegistry } from "./registry-types.js";

export function collectConfiguredWebSearchProviderIds(config: OpenClawConfig): ReadonlySet<string> {
  const search = config.tools?.web?.search;
  if (search?.enabled === false || typeof search?.provider !== "string") {
    return new Set();
  }
  const providerId = normalizeOptionalLowercaseString(search.provider);
  return providerId ? new Set([providerId]) : new Set();
}

function collectModelProviderIds(value: unknown): ReadonlySet<string> {
  return new Set(
    listModelRefsFromConfigValue(value)
      .map((ref) => {
        const slashIndex = ref.indexOf("/");
        return slashIndex > 0 ? normalizeProviderId(ref.slice(0, slashIndex)) : "";
      })
      .filter((providerId): providerId is string => Boolean(providerId)),
  );
}

export function collectConfiguredAgentModelProviderIds(
  config: OpenClawConfig,
  manifestRegistry: PluginManifestRegistry,
): ReadonlySet<string> {
  const providerIds = new Set<string>();
  for (const agentId of listAgentIds(config)) {
    const selections = resolveConfiguredRuntimePluginSelections(config, agentId, {
      manifestPlugins: manifestRegistry.plugins,
      allowPluginNormalization: false,
    });
    for (const selection of selections) {
      providerIds.add(selection.provider);
    }
    // Explicit utility routing is a separate startup consumer; unused picker aliases are not.
    const utility = readUtilityModelSetting(config, agentId);
    if (utility.kind === "explicit") {
      const context = {
        cfg: config,
        agentId,
        defaultProvider: selections[0]?.provider ?? DEFAULT_PROVIDER,
        manifestPlugins: manifestRegistry.plugins,
        allowPluginNormalization: false,
      };
      const utilityRef = resolveModelRefFromString({
        ...context,
        raw: utility.modelRef,
        aliasIndex: buildModelAliasIndex(context),
      })?.ref;
      if (utilityRef) {
        providerIds.add(utilityRef.provider);
      }
    }
  }

  if (providerIds.size === 0) {
    return providerIds;
  }
  // Core transports do not replace a selected provider's runtime hooks or CLI backend.
  // Admit the declared owners now, as the immutable agent runtime plan requires,
  // instead of discovering a missing owner and reloading the startup registry later.
  const declaredProviderIds = new Set(
    manifestRegistry.plugins.flatMap((plugin) =>
      [...plugin.providers, ...plugin.cliBackends].map(normalizeProviderId),
    ),
  );
  return new Set([...providerIds].filter((providerId) => declaredProviderIds.has(providerId)));
}

export function manifestOwnsConfiguredModelProvider(params: {
  manifest: PluginManifestRecord | undefined;
  configuredModelProviderIds: ReadonlySet<string>;
}): boolean {
  if (params.configuredModelProviderIds.size === 0) {
    return false;
  }
  return [...(params.manifest?.providers ?? []), ...(params.manifest?.cliBackends ?? [])].some(
    (providerId) => {
      return params.configuredModelProviderIds.has(normalizeProviderId(providerId));
    },
  );
}

export function collectConfiguredGenerationProviderIds(
  config: OpenClawConfig,
): ConfiguredGenerationProviderIds {
  const defaults = config.agents?.defaults;
  return {
    imageGenerationProviders: collectModelProviderIds(defaults?.mediaModels?.image),
    videoGenerationProviders: collectModelProviderIds(defaults?.mediaModels?.video),
    musicGenerationProviders: collectModelProviderIds(defaults?.mediaModels?.music),
  };
}

export function collectConfiguredVoiceProviderIds(
  config: OpenClawConfig,
): ConfiguredVoiceProviderIds {
  const providerIds = collectModelProviderIds(config.agents?.defaults?.voiceModel);
  const realtimeProviderIds = new Set(providerIds);
  const talkRealtimeProviderId = resolveConfiguredTalkRealtimeProviderId(config);
  if (talkRealtimeProviderId) {
    realtimeProviderIds.add(talkRealtimeProviderId.toLowerCase());
  }
  return {
    speechProviders: providerIds,
    realtimeTranscriptionProviders: providerIds,
    realtimeVoiceProviders: realtimeProviderIds,
  };
}

// Explicit memory provider startup pulls plugin-owned providers into Gateway
// boot. Missing/"auto" stays lazy, and "none" disables provider-backed embeddings.
const MEMORY_EMBEDDING_PROVIDER_STARTUP_SKIP_IDS: ReadonlySet<string> = new Set(["auto", "none"]);

function normalizeMemoryEmbeddingProviderIdValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized || undefined;
}

function normalizeExplicitMemoryEmbeddingProviderId(value: unknown): string | undefined {
  const normalized = normalizeMemoryEmbeddingProviderIdValue(value);
  return normalized && !MEMORY_EMBEDDING_PROVIDER_STARTUP_SKIP_IDS.has(normalized)
    ? normalized
    : undefined;
}

function readMemorySearchEnabled(
  memorySearch: Record<string, unknown> | undefined,
): boolean | undefined {
  const enabled = memorySearch?.enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

function isMemorySlotExplicitlyDisabled(config: OpenClawConfig): boolean {
  return normalizeOptionalLowercaseString(config.plugins?.slots?.memory) === "none";
}

type MemoryEmbeddingStartupProviderSource = "provider" | "fallback";

type ConfiguredMemoryEmbeddingStartupProviderOwner = {
  /** Raw memory-search provider id as configured (normalized). */
  configuredId: string;
  /**
   * Adapter ids a plugin can own for this provider: the configured id plus its
   * `models.providers.<id>.api` owner when a custom provider maps to one.
   */
  ownerIds: ReadonlySet<string>;
  agentIds: Set<string>;
  source: MemoryEmbeddingStartupProviderSource;
};

/**
 * Resolve a configured memory embedding provider id to the adapter id(s) a
 * plugin manifest contract or runtime registry can own. Mirrors runtime
 * `getConfiguredMemoryEmbeddingProvider`: the raw id maps to a direct adapter,
 * and a custom `models.providers.<id>` entry additionally maps to its `api`
 * owner adapter (`provider: "ollama-5080"` with `api: "ollama"` -> "ollama").
 * Both candidates are returned so matching covers the direct adapter and the
 * API owner without the runtime adapter registry.
 */
function resolveMemoryEmbeddingProviderOwnerIds(
  providerId: string,
  config: OpenClawConfig,
): string[] {
  const ownerIds = [providerId];
  const genericOwnerId = normalizeOptionalLowercaseString(
    resolveConfiguredGenericEmbeddingProviderId(providerId, config),
  );
  if (genericOwnerId && genericOwnerId !== providerId) {
    ownerIds.push(genericOwnerId);
  }
  const ownerApi = normalizeOptionalLowercaseString(
    findNormalizedProviderValue(config.models?.providers, providerId)?.api,
  );
  if (ownerApi && ownerApi !== providerId) {
    ownerIds.push(ownerApi);
  }
  return ownerIds;
}

function resolveEffectiveMemoryEmbeddingProviderEntries(
  defaults: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Array<{
  configuredId: string;
  source: MemoryEmbeddingStartupProviderSource;
}> {
  const enabled = readMemorySearchEnabled(override) ?? readMemorySearchEnabled(defaults) ?? true;
  if (!enabled) {
    return [];
  }
  const rawProvider = normalizeMemoryEmbeddingProviderIdValue(
    override?.provider ?? defaults?.provider,
  );
  const effectiveProvider = rawProvider === "auto" || !rawProvider ? "openai" : rawProvider;
  if (effectiveProvider === "none") {
    return [];
  }
  const entries: Array<{
    configuredId: string;
    source: MemoryEmbeddingStartupProviderSource;
  }> = [];
  const provider =
    rawProvider && !MEMORY_EMBEDDING_PROVIDER_STARTUP_SKIP_IDS.has(rawProvider)
      ? rawProvider
      : undefined;
  if (provider) {
    entries.push({ configuredId: provider, source: "provider" });
  }
  const fallback = normalizeExplicitMemoryEmbeddingProviderId(
    override?.fallback ?? defaults?.fallback ?? "none",
  );
  if (fallback && fallback !== effectiveProvider) {
    entries.push({ configuredId: fallback, source: "fallback" });
  }
  return entries;
}

/**
 * Collect explicit memory embedding provider owners required by startup. The
 * resolver mirrors runtime memory-search inheritance for enablement, primary
 * provider, and fallback provider, then maps custom `models.providers` ids to
 * their API-owner adapter ids.
 */
export function collectConfiguredMemoryEmbeddingStartupProviderOwners(
  config: OpenClawConfig,
): ConfiguredMemoryEmbeddingStartupProviderOwner[] {
  if (isMemorySlotExplicitlyDisabled(config)) {
    return [];
  }
  const byConfiguredIdAndSource = new Map<string, ConfiguredMemoryEmbeddingStartupProviderOwner>();
  const defaultsBlock = config.memory?.search;
  const defaults = isRecord(defaultsBlock) ? defaultsBlock : undefined;
  const addEffectiveProviders = (
    override: Record<string, unknown> | undefined,
    agentId?: string,
  ) => {
    for (const { configuredId, source } of resolveEffectiveMemoryEmbeddingProviderEntries(
      defaults,
      override,
    )) {
      const key = `${source}\0${configuredId}`;
      const existing = byConfiguredIdAndSource.get(key);
      if (existing) {
        if (agentId) {
          existing.agentIds.add(agentId);
        }
        continue;
      }
      byConfiguredIdAndSource.set(key, {
        configuredId,
        ownerIds: new Set(resolveMemoryEmbeddingProviderOwnerIds(configuredId, config)),
        agentIds: new Set(agentId ? [agentId] : []),
        source,
      });
    }
  };
  const agentEntries = listAgentEntries(config);
  addEffectiveProviders(undefined, agentEntries.length === 0 ? listAgentIds(config)[0] : undefined);
  if (agentEntries.length === 0) {
    return [...byConfiguredIdAndSource.values()];
  }
  for (const agent of agentEntries) {
    const memory = isRecord(agent.memory) ? agent.memory : undefined;
    addEffectiveProviders(
      isRecord(memory?.search) ? memory.search : undefined,
      normalizeAgentId(agent.id),
    );
  }
  return [...byConfiguredIdAndSource.values()];
}

/**
 * Collect configured memory embedding provider ids that map to a plugin-owned
 * memory embedding provider contract, including the resolved `api` owner for
 * custom `models.providers` ids so the owning plugin loads at startup.
 */
export function collectConfiguredMemoryEmbeddingProviderIds(
  config: OpenClawConfig,
): ReadonlySet<string> {
  const providerIds = new Set<string>();
  for (const provider of collectConfiguredMemoryEmbeddingStartupProviderOwners(config)) {
    for (const ownerId of provider.ownerIds) {
      providerIds.add(ownerId);
    }
  }
  return providerIds;
}

/**
 * Report configured memory embedding providers that no loaded plugin can serve.
 * A provider is unregistered only when none of its resolved adapter ids (the
 * configured id and its `models.providers.<id>.api` owner) was registered, so
 * custom providers warn when their API-owner plugin is missing but stay quiet
 * once that plugin loads.
 */
export function collectUnregisteredConfiguredMemoryEmbeddingProviders(params: {
  config: OpenClawConfig;
  registeredProviderIds: ReadonlySet<string>;
}): Array<{ configuredId: string; source: MemoryEmbeddingStartupProviderSource }> {
  const configured = collectConfiguredMemoryEmbeddingStartupProviderOwners(params.config);
  if (configured.length === 0) {
    return [];
  }
  const registered = new Set(
    [...params.registeredProviderIds]
      .map((id) => normalizeOptionalLowercaseString(id))
      .filter((id): id is string => Boolean(id)),
  );
  return configured
    .filter((provider) => ![...provider.ownerIds].some((ownerId) => registered.has(ownerId)))
    .map((provider) => ({ configuredId: provider.configuredId, source: provider.source }))
    .toSorted(
      (left, right) =>
        left.configuredId.localeCompare(right.configuredId) ||
        left.source.localeCompare(right.source),
    );
}

// Registered embedding provider ids the loaded runtime can actually serve: the live
// registry's embedding providers plus the global/core embedding registry. Shared by
// gateway boot and `/status plugins` so both agree on what counts as registered.
export function collectRegisteredEmbeddingProviderIds(
  registry: Partial<Pick<PluginRegistry, "embeddingProviders">>,
): Set<string> {
  return new Set(
    [
      ...(registry.embeddingProviders ?? []),
      ...listRegisteredEmbeddingProviders().map((entry) => ({ provider: entry.adapter })),
    ].map((entry) => entry.provider.id),
  );
}
