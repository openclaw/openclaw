import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { splitTrailingAuthProfile } from "../../../../src/agents/model-ref-profile.js";
import { normalizeAgentModelRefForConfig } from "../../../../src/config/model-input.js";
import { parseModelPolicyWildcardRef } from "../../../../src/config/model-policy-ref.js";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { buildCatalogDisplayLookup, buildChatModelOptionFromLookup } from "../chat/model-ref.ts";
import { resolveAgentConfigEntryTarget } from "../config/config-state-model.ts";
import { resolveAgentConfig } from "./display.ts";

type ConfiguredModelOption = {
  value: string;
  label: string;
  provider?: string;
  tags?: string[];
  alias?: string;
  disabled?: boolean;
};

function resolveConfiguredModels(
  configForm: Record<string, unknown> | null,
  agentId?: string,
): ConfiguredModelOption[] {
  const defaults = asOptionalRecord(asOptionalRecord(configForm?.agents)?.defaults);
  const defaultModels = asOptionalRecord(defaults?.models);
  const agentModels = agentId ? resolveAgentConfig(configForm, agentId)?.entry?.models : undefined;
  const modelIds = Object.keys({ ...defaultModels, ...agentModels });
  const options: ConfiguredModelOption[] = [];
  for (const modelId of modelIds) {
    const trimmed = modelId.trim();
    if (!trimmed) {
      continue;
    }
    const defaultMetadata = asOptionalRecord(defaultModels?.[modelId]);
    const agentMetadata = agentModels?.[modelId];
    const alias =
      agentMetadata?.alias !== undefined
        ? (normalizeOptionalString(agentMetadata.alias) ?? "")
        : normalizeOptionalString(defaultMetadata?.alias);
    const separator = trimmed.indexOf("/");
    options.push({
      value: trimmed,
      label: alias && alias !== trimmed ? `${alias} (${trimmed})` : trimmed,
      provider: separator > 0 ? trimmed.slice(0, separator) : undefined,
      alias,
    });
  }
  return options;
}

/** Resolve primary exclusions from the current draft without changing authored fallback identity. */
export function createPrimaryModelExclusion(
  configForm: Record<string, unknown> | null,
  primary: string | null,
  agentId?: string,
): (value: string) => boolean {
  if (!primary) {
    return () => false;
  }
  const agents = asOptionalRecord(configForm?.agents);
  const defaults = asOptionalRecord(agents?.defaults);
  const entry = agentId ? resolveAgentConfigEntryTarget(configForm, agentId)?.entry : undefined;
  const modelMaps = [asOptionalRecord(defaults?.models), asOptionalRecord(entry?.models)];
  const aliasesByValue = new Map<string, string>();
  for (const models of modelMaps) {
    for (const [model, metadata] of Object.entries(models ?? {})) {
      if (parseModelPolicyWildcardRef(model)) {
        continue;
      }
      if (!isRecord(metadata) || !Object.hasOwn(metadata, "alias")) {
        continue;
      }
      const key = normalizeAgentModelRefForConfig(model);
      // Match runtime alias precedence: explicit agent aliases move after defaults.
      aliasesByValue.delete(key);
      aliasesByValue.set(key, normalizeOptionalString(metadata.alias) ?? "");
    }
  }
  const aliases = new Map<string, string>();
  const providerAliases = new Map<string, string>();
  for (const [model, alias] of aliasesByValue) {
    if (alias) {
      const aliasKey = normalizeLowercaseStringOrEmpty(alias);
      aliases.set(aliasKey, model);
      const ref = parseModelCatalogRef(model);
      if (ref) {
        providerAliases.set(`${ref.provider}/${aliasKey}`, model);
      }
    }
  }

  const trimmed = primary.trim();
  const { model: primaryModel, profile: primaryProfile } = splitTrailingAuthProfile(trimmed);
  const exactAlias = aliases.get(normalizeLowercaseStringOrEmpty(trimmed));
  const profileAlias = primaryProfile
    ? (exactAlias ?? aliases.get(normalizeLowercaseStringOrEmpty(primaryModel)))
    : undefined;
  const primaryRef = parseModelCatalogRef(primaryModel);
  const configuredModels = asOptionalRecord(configForm?.models);
  const providers = asOptionalRecord(configuredModels?.providers);
  const providerConfig = asOptionalRecord(
    primaryRef ? findNormalizedProviderValue(providers, primaryRef.provider) : undefined,
  );
  const providerApi = normalizeLowercaseStringOrEmpty(providerConfig?.api);
  const ownsProviderRef = Boolean(providerApi && providerApi !== primaryRef?.provider);
  let selectedPrimary = primaryModel;
  if (profileAlias) {
    selectedPrimary = profileAlias;
  } else if (
    !primaryProfile &&
    exactAlias &&
    !ownsProviderRef &&
    (!primaryRef || parseModelCatalogRef(exactAlias))
  ) {
    selectedPrimary = exactAlias;
  }
  const primaryKey = normalizeAgentModelRefForConfig(selectedPrimary);

  return (value) => {
    const { model, profile } = splitTrailingAuthProfile(value);
    const ref = parseModelCatalogRef(model);
    // Fallback aliases are matched after stripping profiles, unlike configured primaries.
    const candidate =
      aliases.get(normalizeLowercaseStringOrEmpty(model)) ??
      (ref
        ? providerAliases.get(`${ref.provider}/${normalizeLowercaseStringOrEmpty(ref.modelId)}`)
        : undefined) ??
      model;
    return (
      normalizeAgentModelRefForConfig(candidate) === primaryKey &&
      (!profile || profile === primaryProfile)
    );
  };
}

/** Build the scoped catalog once; only the picker with an unlisted selection adds it. */
export function createAgentModelOptions(
  configForm: Record<string, unknown> | null,
  catalog?: ModelCatalogEntry[],
  agentId?: string,
) {
  const seen = new Set<string>();
  const options: ConfiguredModelOption[] = [];
  const catalogOptions = new Map<string, ConfiguredModelOption>();
  const configuredOptions = resolveConfiguredModels(configForm, agentId);
  const addOption = (option: ConfiguredModelOption) => {
    const key = normalizeAgentModelRefForConfig(option.value);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push(option);
  };

  if (catalog) {
    const configuredAliases = new Map(
      configuredOptions.map(
        (option) => [normalizeAgentModelRefForConfig(option.value), option.alias] as const,
      ),
    );
    const displayCatalog = catalog.map((entry) => {
      const key = normalizeAgentModelRefForConfig(`${entry.provider}/${entry.id}`);
      const alias = configuredAliases.get(key);
      if (alias === undefined) {
        return entry;
      }
      return { ...entry, alias: alias || undefined };
    });
    const displayLookup = buildCatalogDisplayLookup(displayCatalog);
    for (const entry of displayCatalog) {
      const option = buildChatModelOptionFromLookup(entry, displayLookup);
      catalogOptions.set(normalizeAgentModelRefForConfig(option.value), {
        ...option,
        provider: entry.provider,
        tags: entry.tags,
        ...(entry.available === false ? { disabled: true } : {}),
      });
    }
  }

  for (const opt of configuredOptions) {
    // Raw config supplies rows the Gateway catalog lacks and explicit alias edits;
    // catalog identity and tags remain authoritative for matching rows.
    const catalogOption = catalogOptions.get(normalizeAgentModelRefForConfig(opt.value));
    addOption(catalogOption ?? opt);
  }

  for (const option of catalogOptions.values()) {
    addOption(option);
  }

  return {
    options,
    withCurrent(current?: string | null): ConfiguredModelOption[] {
      if (!current || seen.has(normalizeAgentModelRefForConfig(current))) {
        return options;
      }
      const separator = current.indexOf("/");
      return [
        {
          value: current,
          label: current,
          provider: separator > 0 ? current.slice(0, separator) : undefined,
        },
        ...options,
      ];
    },
  };
}
