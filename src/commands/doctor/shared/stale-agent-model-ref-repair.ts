import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  listAgentEntries,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId,
} from "../../../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { normalizeProviderId } from "../../../agents/model-selection.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasIncompletePluginDiscovery } from "../../../plugins/discovery-availability.js";
import { resolvePluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import { resolveProviderInstallCatalogEntries } from "../../../plugins/provider-install-catalog.js";
import { listMutableCodexRouteAgentEntries } from "./codex-route-agent-entries.js";
import { collectConfiguredProviderSelectionIds } from "./configured-provider-selection-ids.js";
import {
  createRetiredModelRefRepairResolver,
  repairRetiredConfigModelRefs,
} from "./retired-model-ref-repair.js";

type StaleAgentModelRefRepair = {
  config: OpenClawConfigWithLegacyRoster;
  changes: string[];
  warnings: string[];
  retiredModelRefConfig?: Record<string, unknown>;
};

type RepairOptions = {
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  /** Test seam for the provider ids supplied by bundled or installed plugins. */
  pluginProviderIds?: ReadonlySet<string>;
  /** Test seam for provider ids already present in each agent's models.json. */
  persistedProviderIdsByAgentId?: ReadonlyMap<string, ReadonlySet<string>>;
};

const DEFAULT_MODEL_REF = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;

function providerFromModelRef(ref: string): string | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }
  const provider = normalizeProviderId(trimmed.slice(0, slash));
  return provider || undefined;
}

function collectPluginProviderIds(
  cfg: OpenClawConfig,
  options: RepairOptions,
): { providerIds?: Set<string>; warnings: string[] } {
  let providerIds: Set<string>;
  if (options.pluginProviderIds) {
    providerIds = new Set([...options.pluginProviderIds].map(normalizeProviderId).filter(Boolean));
  } else {
    const defaultAgentId = tryResolveDefaultAgentId(cfg);
    const workspaceDir = defaultAgentId ? resolveAgentWorkspaceDir(cfg, defaultAgentId) : undefined;
    const snapshot =
      options.pluginMetadataSnapshot ??
      resolvePluginMetadataSnapshot({
        config: cfg,
        workspaceDir: workspaceDir ?? undefined,
        env: options.env ?? process.env,
        allowWorkspaceScopedCurrent: true,
      });
    if (hasIncompletePluginDiscovery(snapshot.diagnostics)) {
      return {
        warnings: [
          "Skipped stale agent model reference repair because plugin discovery is incomplete; uninspected configuration is preserved.",
        ],
      };
    }

    providerIds = new Set(
      [
        snapshot.owners.providers,
        snapshot.owners.modelCatalogProviders,
        snapshot.owners.setupProviders,
        snapshot.owners.cliBackends,
      ].flatMap((owners) => [...owners.keys()].map(normalizeProviderId).filter(Boolean)),
    );
  }
  const selectedProviderIds = collectConfiguredProviderSelectionIds(cfg);
  for (const entry of resolveProviderInstallCatalogEntries({
    config: cfg,
    env: options.env ?? process.env,
    includeUntrustedWorkspacePlugins: false,
  })) {
    const entryProviderIds = [entry.providerId, ...(entry.providerAliases ?? [])];
    if (!entryProviderIds.some((providerId) => selectedProviderIds.has(providerId.toLowerCase()))) {
      continue;
    }
    for (const providerId of entryProviderIds.map(normalizeProviderId).filter(Boolean)) {
      providerIds.add(providerId);
    }
  }
  return { providerIds, warnings: [] };
}

function collectPersistedProviderIds(params: {
  cfg: OpenClawConfig;
  agentId: string;
  env: NodeJS.ProcessEnv;
  injected?: ReadonlyMap<string, ReadonlySet<string>>;
}): { providerIds?: Set<string>; warning?: string } {
  if (params.injected) {
    const injected = params.injected.get(params.agentId) ?? [];
    return {
      providerIds: new Set([...injected].map(normalizeProviderId).filter(Boolean)),
    };
  }

  const modelsPath = path.join(
    resolveAgentDir(params.cfg, params.agentId, params.env),
    "models.json",
  );
  let raw: string;
  try {
    raw = fs.readFileSync(modelsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { providerIds: new Set() };
    }
    return {
      warning: `Skipped stale model reference repair for agent "${params.agentId}" because ${modelsPath} could not be read.`,
    };
  }
  try {
    const parsed = JSON.parse(raw) as { providers?: unknown };
    if (!isRecord(parsed.providers)) {
      return { providerIds: new Set() };
    }
    return {
      providerIds: new Set(Object.keys(parsed.providers).map(normalizeProviderId).filter(Boolean)),
    };
  } catch {
    return {
      warning: `Skipped stale model reference repair for agent "${params.agentId}" because ${modelsPath} is invalid JSON.`,
    };
  }
}

function repairModelMap(params: {
  models: Record<string, unknown> | undefined;
  path: string;
  isStale: (ref: string) => string | undefined;
  replacementRef?: string;
  ensureReplacement?: boolean;
  changes: string[];
  warnings: string[];
}): void {
  if (!isRecord(params.models)) {
    return;
  }
  const refs = Object.keys(params.models);
  const staleRefs = refs.filter((ref) => params.isStale(ref));
  if (staleRefs.length === refs.length && staleRefs.length > 0 && !params.replacementRef) {
    params.warnings.push(
      `Skipped clearing ${params.path} because no available replacement model could keep the allowlist restrictive.`,
    );
    return;
  }
  for (const ref of staleRefs) {
    const provider = params.isStale(ref);
    delete params.models[ref];
    params.changes.push(
      `Removed stale ${params.path} entry "${ref}" (provider "${provider}" is unavailable).`,
    );
  }
  if (
    refs.length > 0 &&
    (staleRefs.length > 0 || params.ensureReplacement === true) &&
    params.replacementRef &&
    !Object.hasOwn(params.models, params.replacementRef)
  ) {
    params.models[params.replacementRef] = {};
    params.changes.push(
      `Added ${params.path} entry "${params.replacementRef}" to keep the repaired allowlist restrictive.`,
    );
  }
}

function firstExplicitModelRef(cfg: OpenClawConfig): string | undefined {
  if (!isRecord(cfg.models?.providers)) {
    return undefined;
  }
  for (const [providerId, provider] of Object.entries(cfg.models.providers)) {
    if (!isRecord(provider) || !Array.isArray(provider.models)) {
      continue;
    }
    const normalizedProvider = normalizeProviderId(providerId);
    const modelId = provider.models
      .map((model) => (isRecord(model) && typeof model.id === "string" ? model.id.trim() : ""))
      .find(Boolean);
    if (normalizedProvider && modelId) {
      return `${normalizedProvider}/${modelId}`;
    }
  }
  return undefined;
}

function modelPrimaryRef(model: unknown): string | undefined {
  if (typeof model === "string") {
    return model;
  }
  return isRecord(model) && typeof model.primary === "string" ? model.primary : undefined;
}

export function repairStaleAgentModelRefs(
  cfg: unknown,
  options: RepairOptions = {},
): StaleAgentModelRefRepair {
  if (!isRecord(cfg)) {
    throw new TypeError("Stale agent model repair requires a config object");
  }
  const configuredModels = asOptionalRecord(cfg.models);
  const replaceMode = configuredModels?.mode === "replace";
  const pluginProviders = replaceMode
    ? { providerIds: new Set<string>(), warnings: [] }
    : collectPluginProviderIds(cfg, options);
  if (!pluginProviders.providerIds) {
    return { config: cfg, changes: [], warnings: pluginProviders.warnings };
  }

  // Bundled core providers declare provider ownership in their plugin manifests,
  // so the metadata snapshot is the canonical inventory for both core and plugins.
  const baseAvailableProviders = pluginProviders.providerIds;
  if (!replaceMode) {
    baseAvailableProviders.add(normalizeProviderId(DEFAULT_PROVIDER));
  }
  for (const providerId of Object.keys(asOptionalRecord(configuredModels?.providers) ?? {})
    .map(normalizeProviderId)
    .filter(Boolean)) {
    baseAvailableProviders.add(providerId);
  }
  const config = structuredClone(cfg);
  const changes: string[] = [];
  const warnings = [...pluginProviders.warnings];
  const env = options.env ?? process.env;
  const availabilityForAgents = (
    agentIds: string[],
    aggregation: "union" | "intersection",
  ): Set<string> | undefined => {
    const available = new Set(baseAvailableProviders);
    if (replaceMode) {
      return available;
    }
    if (agentIds.length === 0) {
      const defaultAgentId = tryResolveDefaultAgentId(cfg);
      if (defaultAgentId) {
        agentIds.push(defaultAgentId);
      }
    }
    let combined: Set<string> | undefined;
    for (const agentId of agentIds) {
      const { providerIds, warning } = collectPersistedProviderIds({
        cfg,
        agentId,
        env,
        injected: options.persistedProviderIdsByAgentId,
      });
      if (!providerIds) {
        if (warning) {
          warnings.push(warning);
        }
        return undefined;
      }
      combined =
        combined && aggregation === "intersection"
          ? new Set([...combined].filter((providerId) => providerIds.has(providerId)))
          : new Set([...(combined ?? []), ...providerIds]);
    }
    for (const providerId of combined ?? []) {
      available.add(providerId);
    }
    return available;
  };
  const availabilityForAgent = (agentId: string) => availabilityForAgents([agentId], "union");
  const availabilityForDefaults = (
    aggregation: "union" | "intersection",
    select: (agent: ReturnType<typeof listAgentEntries>[number]) => string | undefined,
  ): Set<string> | undefined => {
    if (replaceMode) {
      return new Set(baseAvailableProviders);
    }
    return availabilityForAgents(
      listAgentEntries(cfg)
        .map(select)
        .filter((agentId): agentId is string => agentId !== undefined),
      aggregation,
    );
  };
  const makeStaleChecker = (available: ReadonlySet<string>) => (ref: string) => {
    const provider = providerFromModelRef(ref);
    return provider && !available.has(provider) ? provider : undefined;
  };

  const defaults = asOptionalRecord(asOptionalRecord(config.agents)?.defaults);
  const defaultAvailability = availabilityForDefaults("intersection", (agent) => {
    if (typeof agent.id !== "string") {
      return undefined;
    }
    const explicitPrimary = modelPrimaryRef(agent.model);
    if (!explicitPrimary) {
      return agent.id;
    }
    const agentAvailability = availabilityForAgent(agent.id);
    const provider = providerFromModelRef(explicitPrimary);
    // This stale override will be removed or replaced later in the same repair.
    return agentAvailability && provider && !agentAvailability.has(provider) ? agent.id : undefined;
  });
  const configuredDefaultPrimary = modelPrimaryRef(defaults?.model);
  let repairedDefaultPrimary =
    configuredDefaultPrimary ?? (replaceMode ? firstExplicitModelRef(cfg) : DEFAULT_MODEL_REF);
  const repairModel = (
    owner: Record<string, unknown>,
    modelPath: string,
    isStale: (ref: string) => string | undefined,
    agentId?: string,
  ): boolean => {
    const isDefault = agentId === undefined;
    const model = owner.model;
    const selector = asOptionalRecord(model);
    const primary = modelPrimaryRef(model);
    const provider = primary === undefined ? undefined : isStale(primary);
    let replacement: string | undefined;
    let changed = false;
    if (provider && primary !== undefined) {
      const primaryPath = `${modelPath}${selector ? " primary" : ""}`;
      const container = selector ?? owner;
      const key = selector ? "primary" : "model";
      const availableDefault =
        repairedDefaultPrimary && !isStale(repairedDefaultPrimary)
          ? repairedDefaultPrimary
          : undefined;
      if (
        !isDefault &&
        defaultAvailability &&
        availableDefault &&
        (!replaceMode || modelPrimaryRef(defaults?.model))
      ) {
        delete container[key];
        replacement = selector ? repairedDefaultPrimary : undefined;
        changed = true;
        changes.push(
          `Removed stale ${primaryPath} "${primary}" so agent "${agentId}" inherits the default model (provider "${provider}" is unavailable).`,
        );
      } else {
        const configuredReplacement = isDefault
          ? replaceMode
            ? firstExplicitModelRef(cfg)
            : DEFAULT_MODEL_REF
          : availableDefault;
        const fallbacks: unknown[] = Array.isArray(selector?.fallbacks) ? selector.fallbacks : [];
        replacement =
          isDefault && !replaceMode
            ? configuredReplacement
            : (fallbacks.find(
                (fallback): fallback is string =>
                  typeof fallback === "string" && !isStale(fallback),
              ) ?? configuredReplacement);
        if (replacement) {
          container[key] = replacement;
          changed = true;
          changes.push(
            `Replaced stale ${primaryPath} "${primary}" with ${isDefault ? "default " : ""}"${replacement}" (provider "${provider}" is unavailable).`,
          );
        } else if (isDefault) {
          delete container[key];
          changed = true;
          changes.push(
            `Removed stale ${primaryPath} "${primary}" because provider "${provider}" is unavailable and no replacement model is configured.`,
          );
        } else {
          warnings.push(
            `Skipped stale ${primaryPath} repair because no available inherited or replacement model is configured.`,
          );
        }
      }
    }
    if (selector) {
      if (Array.isArray(selector.fallbacks)) {
        // An empty array disables inherited fallbacks, including after stale refs are removed.
        const fallbacks: unknown[] = selector.fallbacks;
        const filtered = fallbacks.filter((ref) => {
          if (typeof ref !== "string") {
            return true;
          }
          const fallbackProvider = isStale(ref);
          if (!fallbackProvider) {
            return true;
          }
          changes.push(
            `Removed stale ${modelPath} fallback "${ref}" (provider "${fallbackProvider}" is unavailable).`,
          );
          return false;
        });
        selector.fallbacks = filtered;
        if (replacement && filtered.includes(replacement)) {
          const remaining = filtered.filter((ref) => ref !== replacement);
          selector.fallbacks = remaining;
          changes.push(
            `Removed duplicate ${modelPath} fallback "${replacement}" after selecting it as the ${isDefault ? "default primary" : "primary"}.`,
          );
          if (remaining.length === 0) {
            delete selector.fallbacks;
          }
        }
      }
      if (!selector.primary && !selector.fallbacks) {
        delete owner.model;
      }
    }
    return changed;
  };
  let defaultPrimaryChanged = false;
  if (defaults && defaultAvailability) {
    defaultPrimaryChanged = repairModel(
      defaults,
      "agents.defaults.model",
      makeStaleChecker(defaultAvailability),
    );
    repairedDefaultPrimary =
      modelPrimaryRef(defaults.model) ??
      (replaceMode ? firstExplicitModelRef(cfg) : DEFAULT_MODEL_REF);
    const modelMapAvailability = availabilityForDefaults("union", (agent) =>
      isRecord(agent) && typeof agent.id === "string" && !isRecord(agent.models)
        ? agent.id
        : undefined,
    );
    if (modelMapAvailability) {
      repairModelMap({
        models: asOptionalRecord(defaults.models),
        path: "agents.defaults.models",
        isStale: makeStaleChecker(modelMapAvailability),
        replacementRef: repairedDefaultPrimary,
        ensureReplacement: defaultPrimaryChanged,
        changes,
        warnings,
      });
    }
  }

  for (const entry of listMutableCodexRouteAgentEntries(config)) {
    const agent = entry.agent;
    const available = availabilityForAgent(entry.agentId);
    if (!available) {
      continue;
    }
    const isStale = makeStaleChecker(available);
    const agentPrimaryChanged = repairModel(agent, `${entry.path}.model`, isStale, entry.agentId);
    const effectiveAgentPrimary = modelPrimaryRef(agent.model) ?? repairedDefaultPrimary;
    repairModelMap({
      models: isRecord(agent.models) ? agent.models : undefined,
      path: `${entry.path}.models`,
      isStale,
      replacementRef:
        effectiveAgentPrimary && !isStale(effectiveAgentPrimary)
          ? effectiveAgentPrimary
          : undefined,
      ensureReplacement:
        agentPrimaryChanged || (!modelPrimaryRef(agent.model) && defaultPrimaryChanged),
      changes,
      warnings,
    });
  }

  const retired = repairRetiredConfigModelRefs(
    config,
    createRetiredModelRefRepairResolver({
      cfg: config,
      env,
      metadataSnapshot: options.pluginMetadataSnapshot,
      warnings,
    }),
    warnings,
  );
  changes.push(...retired.changes);
  return {
    config: changes.length > 0 ? retired.config : cfg,
    changes,
    warnings,
    ...(retired.changes.length > 0
      ? { retiredModelRefConfig: { agents: config.agents, models: config.models } }
      : {}),
  };
}
