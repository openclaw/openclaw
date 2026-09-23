import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntriesWithSource, readAgentRosterProperty } from "../agents/agent-roster.js";
import { resolveConfiguredProviderFallback } from "../agents/configured-provider-fallback.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveAgentModelPrimaryValue } from "./model-input.js";
import { getConfigResolutionFacts } from "./resolution-facts.js";
import type { AgentModelConfig } from "./types.agents-shared.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function hasUtilityModelSeparationMigrationMarker(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    isRecord(raw.meta) &&
    isRecord(raw.meta.migrations) &&
    raw.meta.migrations.utilityModelSeparation === true
  );
}

/** The shipped implicit primary never excluded a separately configured utility model. */
export function resolveLegacyImplicitPrimaryModelRef(cfg: OpenClawConfig): string {
  const fallback = resolveConfiguredProviderFallback({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  return fallback
    ? `${fallback.provider}/${fallback.model}`
    : `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
}

function validModelParent(model: unknown): boolean {
  return (
    model === undefined ||
    typeof model === "string" ||
    (isRecord(model) && (model.primary === undefined || typeof model.primary === "string"))
  );
}

function canMaterialize(cfg: unknown): boolean {
  if (!isRecord(cfg)) {
    return false;
  }
  const meta = cfg.meta;
  if (meta !== undefined && !isRecord(meta)) {
    return false;
  }
  const migrations = meta?.migrations;
  if (migrations !== undefined && !isRecord(migrations)) {
    return false;
  }
  if (
    migrations?.utilityModelSeparation !== undefined &&
    migrations.utilityModelSeparation !== true
  ) {
    return false;
  }
  const agents = cfg.agents;
  if (agents !== undefined && !isRecord(agents)) {
    return false;
  }
  const defaults = agents?.defaults;
  if ((defaults !== undefined && !isRecord(defaults)) || !validModelParent(defaults?.model)) {
    return false;
  }
  const roster = readAgentRosterProperty(cfg);
  if (!roster) {
    return true;
  }
  if (roster.kind === "entries") {
    return (
      isRecord(roster.value) &&
      Object.values(roster.value).every((entry) => isRecord(entry) && validModelParent(entry.model))
    );
  }
  return (
    Array.isArray(roster.value) &&
    roster.value.every(
      (entry) => isRecord(entry) && typeof entry.id === "string" && validModelParent(entry.model),
    )
  );
}

function withPrimary(model: AgentModelConfig | undefined, primary: string): AgentModelConfig {
  return { ...(isRecord(model) ? model : {}), primary };
}

function hasCatalogRoute(config: OpenClawConfig, primary: string): boolean {
  return Object.entries(config.models?.providers ?? {}).some(
    ([provider, value]) =>
      Array.isArray(value?.models) &&
      value.models.some(
        (model) =>
          typeof model?.id === "string" &&
          `${normalizeProviderId(provider)}/${model.id}` === primary,
      ),
  );
}

function canPinLegacyPrimary(previous: OpenClawConfig, primary: string): boolean {
  // Loaded configs have lost mixed env-template text; the writer owns the authored source.
  if (
    getConfigResolutionFacts(previous) !== null ||
    primary.includes("${") ||
    splitTrailingAuthProfile(primary).model !== primary
  ) {
    return false;
  }
  // Any dynamic row can become the selected fallback after a later environment change.
  return Object.values(previous.models?.providers ?? {}).every(
    (provider) =>
      !Array.isArray(provider?.models) ||
      provider.models.every((model) => typeof model?.id !== "string" || !model.id.includes("${")),
  );
}

function deferSeparation(cfg: OpenClawConfig): { config: OpenClawConfig; changes: string[] } {
  if (!hasUtilityModelSeparationMigrationMarker(cfg)) {
    return { config: cfg, changes: [] };
  }
  const migrations = { ...cfg.meta?.migrations };
  delete migrations.utilityModelSeparation;
  return { config: { ...cfg, meta: { ...cfg.meta, migrations } }, changes: [] };
}

/** Preserve the previous config's implicit primary before separating utility selection. */
export function materializeUtilityModelSeparation(
  cfg: OpenClawConfig,
  previousConfig: unknown = cfg,
): { config: OpenClawConfig; changes: string[] } {
  if (!canMaterialize(cfg)) {
    return { config: cfg, changes: [] };
  }
  let config = cfg;
  const changes: string[] = [];
  if (isRecord(previousConfig) && !hasUtilityModelSeparationMigrationMarker(previousConfig)) {
    const previous: OpenClawConfig = previousConfig;
    if (!canMaterialize(previous)) {
      return { config: cfg, changes: [] };
    }
    const previousDefaults = previous.agents?.defaults;
    const hadConfiguredModel = Object.values(previous.models?.providers ?? {}).some(
      (provider) => Array.isArray(provider?.models) && Boolean(provider.models[0]?.id),
    );
    const previousDefaultPrimary = resolveAgentModelPrimaryValue(previousDefaults?.model);
    const nextDefaultPrimary = resolveAgentModelPrimaryValue(config.agents?.defaults?.model);
    const previousPrimary = resolveLegacyImplicitPrimaryModelRef(previous);
    const removedPreviousRoute =
      hasCatalogRoute(previous, previousPrimary) && !hasCatalogRoute(config, previousPrimary);
    const legacyPrimary = removedPreviousRoute
      ? resolveLegacyImplicitPrimaryModelRef(config)
      : previousPrimary;
    const previousAgents = new Map(
      listAgentEntriesWithSource(previous).map(({ entry }) => [normalizeAgentId(entry.id), entry]),
    );
    const needsLegacyPrimary =
      !previousDefaultPrimary &&
      !nextDefaultPrimary &&
      (hadConfiguredModel ||
        normalizeOptionalString(previousDefaults?.utilityModel) ||
        listAgentEntriesWithSource(config).some(({ entry }) => {
          const prior = previousAgents.get(normalizeAgentId(entry.id));
          return (
            prior &&
            !resolveAgentModelPrimaryValue(prior.model) &&
            !resolveAgentModelPrimaryValue(entry.model) &&
            normalizeOptionalString(prior.utilityModel ?? previousDefaults?.utilityModel)
          );
        }));
    if (
      needsLegacyPrimary &&
      (!canPinLegacyPrimary(previous, legacyPrimary) ||
        (removedPreviousRoute && !canPinLegacyPrimary(config, legacyPrimary)))
    ) {
      return deferSeparation(cfg);
    }
    if (
      !previousDefaultPrimary &&
      !nextDefaultPrimary &&
      (hadConfiguredModel || normalizeOptionalString(previousDefaults?.utilityModel))
    ) {
      config = {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            model: withPrimary(config.agents?.defaults?.model, legacyPrimary),
          },
        },
      };
      changes.push(
        `Preserved the implicit primary model in agents.defaults.model.primary (${legacyPrimary}).`,
      );
    }
    if (!previousDefaultPrimary && !resolveAgentModelPrimaryValue(config.agents?.defaults?.model)) {
      for (const { entry, source } of listAgentEntriesWithSource(config)) {
        const prior = previousAgents.get(normalizeAgentId(entry.id));
        if (
          !prior ||
          resolveAgentModelPrimaryValue(prior.model) ||
          resolveAgentModelPrimaryValue(entry.model) ||
          !normalizeOptionalString(prior.utilityModel ?? previousDefaults?.utilityModel)
        ) {
          continue;
        }
        const model = withPrimary(entry.model, legacyPrimary);
        if (source.kind === "entries") {
          config = {
            ...config,
            agents: {
              ...config.agents,
              entries: {
                ...config.agents?.entries,
                [source.key]: { ...config.agents?.entries?.[source.key], model },
              },
            },
          };
        } else {
          config = {
            ...config,
            agents: {
              ...config.agents,
              list: config.agents?.list?.map((agent, index) =>
                index === source.index ? { ...agent, model } : agent,
              ),
            },
          };
        }
        const path =
          source.kind === "entries"
            ? `agents.entries.${source.key}`
            : `agents.list[${source.index}]`;
        changes.push(
          `Preserved the implicit primary model in ${path}.model.primary (${legacyPrimary}).`,
        );
      }
    }
  }
  if (!hasUtilityModelSeparationMigrationMarker(config)) {
    config = {
      ...config,
      meta: {
        ...config.meta,
        migrations: { ...config.meta?.migrations, utilityModelSeparation: true },
      },
    };
  }
  return { config, changes };
}

/** Utility provider preparation must not change an implicit route whose conversion is deferred. */
export function resolveUtilityModelSeparationError(config: OpenClawConfig): string | undefined {
  if (hasUtilityModelSeparationMigrationMarker(config)) {
    return undefined;
  }
  const migrated = materializeUtilityModelSeparation(config);
  if (migrated.changes.length === 0 && hasUtilityModelSeparationMigrationMarker(migrated.config)) {
    return undefined;
  }
  return "Utility-model setup cannot safely preserve the current implicit primary. Run openclaw doctor --fix to preserve it, or choose an explicit primary model in Model Setup, then retry.";
}
