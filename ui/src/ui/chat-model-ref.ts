import type { ModelCatalogEntry } from "./types.ts";

export type ChatModelOverride =
  | {
      kind: "qualified";
      value: string;
    }
  | {
      kind: "raw";
      value: string;
    };

export type ChatModelResolutionSource = "empty" | "qualified" | "catalog" | "raw" | "server";

export type ChatModelResolutionReason = "empty" | "missing" | "ambiguous";

export type ChatModelResolution = {
  value: string;
  source: ChatModelResolutionSource;
  reason?: ChatModelResolutionReason;
};

export function buildQualifiedChatModelValue(model: string, provider?: string | null): string {
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    return "";
  }
  const trimmedProvider = provider?.trim();
  return trimmedProvider ? `${trimmedProvider}/${trimmedModel}` : trimmedModel;
}

export function createChatModelOverride(value: string): ChatModelOverride | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes("/")) {
    return { kind: "qualified", value: trimmed };
  }
  return { kind: "raw", value: trimmed };
}

export function normalizeChatModelOverrideValue(
  override: ChatModelOverride | null | undefined,
  catalog: ModelCatalogEntry[],
): string {
  return resolveChatModelOverride(override, catalog).value;
}

export function resolveChatModelOverride(
  override: ChatModelOverride | null | undefined,
  catalog: ModelCatalogEntry[],
): ChatModelResolution {
  if (!override) {
    return { value: "", source: "empty", reason: "empty" };
  }
  const trimmed = override?.value.trim();
  if (!trimmed) {
    return { value: "", source: "empty", reason: "empty" };
  }
  if (override.kind === "qualified") {
    return { value: trimmed, source: "qualified" };
  }

  let matchedValue = "";
  for (const entry of catalog) {
    if (entry.id.trim().toLowerCase() !== trimmed.toLowerCase()) {
      continue;
    }
    const candidate = buildQualifiedChatModelValue(entry.id, entry.provider);
    if (!matchedValue) {
      matchedValue = candidate;
      continue;
    }
    if (matchedValue.toLowerCase() !== candidate.toLowerCase()) {
      return { value: trimmed, source: "raw", reason: "ambiguous" };
    }
  }
  if (matchedValue) {
    return { value: matchedValue, source: "catalog" };
  }
  return { value: trimmed, source: "raw", reason: "missing" };
}

export function resolveServerChatModelValue(
  model?: string | null,
  provider?: string | null,
): string {
  if (typeof model !== "string") {
    return "";
  }
  return buildQualifiedChatModelValue(model, provider);
}

export function resolvePreferredServerChatModel(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
): ChatModelResolution {
  if (typeof model !== "string") {
    return { value: "", source: "empty", reason: "empty" };
  }
  const trimmedModel = model.trim();
  if (!trimmedModel) {
    return { value: "", source: "empty", reason: "empty" };
  }

  const trimmedProvider = provider?.trim();
  const overrideResolution = resolveChatModelOverride(
    trimmedProvider ? { kind: "raw", value: trimmedModel } : createChatModelOverride(trimmedModel),
    catalog,
  );
  if (overrideResolution.source === "qualified" || overrideResolution.source === "catalog") {
    return overrideResolution;
  }

  return {
    value: resolveServerChatModelValue(trimmedModel, trimmedProvider),
    source: "server",
    reason: overrideResolution.reason,
  };
}

export function resolvePreferredServerChatModelValue(
  model: string | null | undefined,
  provider: string | null | undefined,
  catalog: ModelCatalogEntry[],
): string {
  return resolvePreferredServerChatModel(model, provider, catalog).value;
}

export function formatChatModelDisplay(value: string): string {
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

function createQualifiedCatalogKey(entry: ModelCatalogEntry): string {
  return buildQualifiedChatModelValue(entry.id, entry.provider).trim().toLowerCase();
}

function createNameProviderKey(name: string, provider?: string | null): string {
  return `${name.toLowerCase()}\u0000${provider?.trim().toLowerCase() ?? ""}`;
}

export type ChatModelDisplayLookup = ReadonlyMap<string, string>;

export function buildCatalogDisplayLookup(catalog: ModelCatalogEntry[]): Map<string, string> {
  const nameToValues = new Map<string, Set<string>>();
  const nameProviderToValues = new Map<string, Set<string>>();

  for (const entry of catalog) {
    const name = entry.name.trim();
    if (!name) {
      continue;
    }

    const qualifiedKey = createQualifiedCatalogKey(entry);
    const normalizedName = name.toLowerCase();
    const providerKey = createNameProviderKey(name, entry.provider);

    const nameValues = nameToValues.get(normalizedName) ?? new Set<string>();
    nameValues.add(qualifiedKey);
    nameToValues.set(normalizedName, nameValues);

    const nameProviderValues = nameProviderToValues.get(providerKey) ?? new Set<string>();
    nameProviderValues.add(qualifiedKey);
    nameProviderToValues.set(providerKey, nameProviderValues);
  }

  const displayLookup = new Map<string, string>();
  for (const entry of catalog) {
    const qualifiedKey = createQualifiedCatalogKey(entry);
    const name = entry.name.trim();
    if (!name) {
      displayLookup.set(qualifiedKey, formatRawCatalogLabel(entry));
      continue;
    }

    const normalizedName = name.toLowerCase();
    if ((nameToValues.get(normalizedName)?.size ?? 0) <= 1) {
      displayLookup.set(qualifiedKey, name);
      continue;
    }

    const provider = entry.provider?.trim();
    if ((nameProviderToValues.get(createNameProviderKey(name, provider))?.size ?? 0) <= 1) {
      displayLookup.set(qualifiedKey, provider ? `${name} · ${provider}` : `${name} · ${entry.id}`);
      continue;
    }

    displayLookup.set(qualifiedKey, `${name} · ${formatRawCatalogLabel(entry)}`);
  }

  return displayLookup;
}

export function formatCatalogEntryDisplay(
  entry: ModelCatalogEntry,
  displayLookup: ChatModelDisplayLookup,
): string {
  return displayLookup.get(createQualifiedCatalogKey(entry)) ?? formatRawCatalogLabel(entry);
}

export function formatCatalogChatModelDisplayFromLookup(
  value: string,
  displayLookup: ChatModelDisplayLookup,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return displayLookup.get(trimmed.toLowerCase()) ?? formatChatModelDisplay(trimmed);
}

export function formatCatalogChatModelDisplay(value: string, catalog: ModelCatalogEntry[]): string {
  return formatCatalogChatModelDisplayFromLookup(value, buildCatalogDisplayLookup(catalog));
}

export function buildChatModelOption(
  entry: ModelCatalogEntry,
  catalog: ModelCatalogEntry[] = [entry],
): { value: string; label: string } {
  return buildChatModelOptionFromLookup(entry, buildCatalogDisplayLookup(catalog));
}

export function buildChatModelOptionFromLookup(
  entry: ModelCatalogEntry,
  displayLookup: ChatModelDisplayLookup,
): { value: string; label: string } {
  const provider = entry.provider?.trim();
  return {
    value: buildQualifiedChatModelValue(entry.id, provider),
    label: formatCatalogEntryDisplay(entry, displayLookup),
  };
}
