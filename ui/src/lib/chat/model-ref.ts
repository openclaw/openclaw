import { isLegacyCodexProviderId } from "../../../../src/config/legacy-codex-provider.js";
import { normalizeAgentModelRefForConfig } from "../../../../src/config/model-input.js";
import type { ModelCatalogEntry } from "../../api/types.ts";

export function normalizeChatModelProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return isLegacyCodexProviderId(normalized) ? "openai" : normalized;
}

export function buildQualifiedChatModelValue(model: string, provider?: string | null): string {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    return "";
  }
  const trimmedProvider = provider?.trim();
  if (!trimmedProvider) {
    return trimmedModel;
  }
  const providerPrefix = `${trimmedProvider.toLowerCase()}/`;
  return trimmedModel.toLowerCase().startsWith(providerPrefix)
    ? trimmedModel
    : `${trimmedProvider}/${trimmedModel}`;
}

export function normalizeChatModelOverrideValue(
  value: string | null | undefined,
  catalog: ModelCatalogEntry[],
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.includes("/")
    ? trimmed
    : resolveUniqueCatalogValueById(trimmed, catalog) || trimmed;
}

function hasCatalogQualifiedValue(catalog: ModelCatalogEntry[], value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return catalog.some(
    (entry) => buildQualifiedChatModelValue(entry.id, entry.provider).toLowerCase() === normalized,
  );
}

function resolveUniqueCatalogValueById(model: string, catalog: ModelCatalogEntry[]): string {
  const normalizedModel = model.trim().toLowerCase();
  if (!normalizedModel) {
    return "";
  }

  const values = catalog
    .filter((entry) => entry.id.trim().toLowerCase() === normalizedModel)
    .map((entry) => buildQualifiedChatModelValue(entry.id, entry.provider));
  const first = values[0] ?? "";
  return values.every((value) => value.toLowerCase() === first.toLowerCase()) ? first : "";
}

export function resolvePreferredServerChatModelValue(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
): string {
  if (typeof model !== "string") {
    return "";
  }
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    return "";
  }

  const trimmedProvider = provider?.trim();

  if (!trimmedProvider) {
    return normalizeChatModelOverrideValue(trimmedModel, catalog);
  }

  if (!trimmedModel.includes("/")) {
    const normalized = normalizeChatModelOverrideValue(trimmedModel, catalog);
    return normalized !== trimmedModel
      ? normalized
      : buildQualifiedChatModelValue(trimmedModel, trimmedProvider);
  }

  const qualifiedServerValue = buildQualifiedChatModelValue(trimmedModel, trimmedProvider);
  const normalizedModel = trimmedModel.toLowerCase();
  const normalizedProvider = normalizeChatModelProviderId(trimmedProvider);
  const serverProviderOwnsRawModelId = catalog.some(
    (entry) =>
      entry.id.trim().toLowerCase() === normalizedModel &&
      normalizeChatModelProviderId(entry.provider) === normalizedProvider,
  );

  // Session model/provider fields form one server-owned pair. Prefer the provider-qualified
  // route only when the catalog confirms that provider owns this raw nested model id.
  if (serverProviderOwnsRawModelId && hasCatalogQualifiedValue(catalog, qualifiedServerValue)) {
    return qualifiedServerValue;
  }

  if (hasCatalogQualifiedValue(catalog, trimmedModel)) {
    return trimmedModel;
  }

  if (hasCatalogQualifiedValue(catalog, qualifiedServerValue)) {
    return qualifiedServerValue;
  }

  const matchedCatalogValue = resolveUniqueCatalogValueById(trimmedModel, catalog);
  if (matchedCatalogValue) {
    return matchedCatalogValue;
  }

  // Without catalog confirmation, preserve slash-containing server values as-is.
  // Re-qualifying them here can turn an already-qualified ref under a stale
  // provider into a nonsense double-prefix like "zai/openai/gpt-5-mini".
  return trimmedModel;
}

function formatChatModelDisplay(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const separator = trimmed.indexOf("/");
  if (separator <= 0) {
    return trimmed;
  }
  return `${trimmed.slice(separator + 1)} · ${trimmed.slice(0, separator)}`;
}

function formatRawCatalogLabel(entry: ModelCatalogEntry): string {
  const provider = entry.provider?.trim();
  return provider ? `${entry.id} · ${provider}` : entry.id;
}

function resolveCatalogDisplayName(entry: ModelCatalogEntry): string {
  let name = entry.name.trim();
  let alias = entry.alias?.trim();
  if (normalizeChatModelProviderId(entry.provider) === "clawrouter") {
    // The provider group already identifies the route; keep model labels model-only.
    name = name.replace(/\s+via\s+clawrouter$/iu, "");
    alias = alias?.replace(/\s+via\s+clawrouter$/iu, "");
  }
  if (!name || !alias) {
    return name || alias || "";
  }
  const normalizedName = name.toLowerCase();
  const normalizedAlias = alias.toLowerCase();
  // Only omit a whole family name immediately before a trailing numeric version.
  // Substrings and custom route/configuration labels still add information.
  const family = normalizedName.replace(/[\s-]+\d+(?:\.\d+)*$/u, "");
  if (
    normalizedAlias === normalizedName ||
    (family !== normalizedName &&
      (family === normalizedAlias || family.endsWith(` ${normalizedAlias}`)))
  ) {
    return name;
  }
  // Aliases are selectable metadata, not a replacement for model identity.
  // Preserve richer custom labels only when they already contain the full name.
  return normalizedAlias.includes(normalizedName) ? alias : `${name} · ${alias}`;
}

type ChatModelDisplayLookup = ReadonlyMap<string, string>;

export function buildCatalogDisplayLookup(catalog: ModelCatalogEntry[]): Map<string, string> {
  // Provider icons and provider groups already identify the route, so only models
  // sharing a display name within the same provider group need disambiguation.
  const nameGroupToValues = new Map<string, Set<string>>();
  const nameProviderToValues = new Map<string, Set<string>>();
  const entries = catalog.map((entry) => {
    const name = resolveCatalogDisplayName(entry);
    const nameKey = name.toLowerCase();
    const provider = entry.provider?.trim().toLowerCase() ?? "";
    return {
      entry,
      name,
      qualifiedKey: normalizeAgentModelRefForConfig(
        buildQualifiedChatModelValue(entry.id, entry.provider),
      ),
      groupKey: `${nameKey}\u0000${normalizeChatModelProviderId(entry.provider)}`,
      providerKey: `${nameKey}\u0000${provider}`,
    };
  });

  for (const { name, qualifiedKey, groupKey, providerKey } of entries) {
    if (!name) {
      continue;
    }
    const groupValues = nameGroupToValues.get(groupKey) ?? new Set<string>();
    groupValues.add(qualifiedKey);
    nameGroupToValues.set(groupKey, groupValues);

    const nameProviderValues = nameProviderToValues.get(providerKey) ?? new Set<string>();
    nameProviderValues.add(qualifiedKey);
    nameProviderToValues.set(providerKey, nameProviderValues);
  }

  return new Map(
    entries.map(({ entry, name, qualifiedKey, groupKey, providerKey }) => {
      let label = name || formatRawCatalogLabel(entry);
      if (name && (nameGroupToValues.get(groupKey)?.size ?? 0) > 1) {
        const detail =
          (nameProviderToValues.get(providerKey)?.size ?? 0) <= 1
            ? entry.provider?.trim() || entry.id
            : entry.id;
        label = `${name} · ${detail}`;
      }
      return [qualifiedKey, label];
    }),
  );
}

export function formatCatalogChatModelDisplayFromLookup(
  value: string,
  displayLookup: ChatModelDisplayLookup,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return (
    displayLookup.get(normalizeAgentModelRefForConfig(trimmed)) ?? formatChatModelDisplay(trimmed)
  );
}

export function buildChatModelOptionFromLookup(
  entry: ModelCatalogEntry,
  displayLookup: ChatModelDisplayLookup,
): { value: string; label: string } {
  const value = buildQualifiedChatModelValue(entry.id, entry.provider);
  return {
    value,
    label:
      displayLookup.get(normalizeAgentModelRefForConfig(value)) ?? formatRawCatalogLabel(entry),
  };
}
