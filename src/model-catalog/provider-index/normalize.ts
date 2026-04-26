import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeTrimmedStringList } from "../../shared/string-normalization.js";
import { isRecord } from "../../utils.js";
import { normalizeModelCatalog } from "../normalize.js";
import { normalizeModelCatalogProviderId } from "../refs.js";
import type { ModelCatalogProvider } from "../types.js";
import type {
  OpenClawProviderIndex,
  OpenClawProviderIndexPlugin,
  OpenClawProviderIndexProvider,
} from "./types.js";

const OPENCLAW_PROVIDER_INDEX_VERSION = 1;

function normalizeSafeKey(value: unknown): string {
  const key = normalizeOptionalString(value) ?? "";
  return key && !isBlockedObjectKey(key) ? key : "";
}

function normalizePlugin(value: unknown): OpenClawProviderIndexPlugin | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = normalizeSafeKey(value.id);
  if (!id) {
    return undefined;
  }
  const packageName = normalizeOptionalString(value.package) ?? "";
  const source = normalizeOptionalString(value.source) ?? "";
  return {
    id,
    ...(packageName ? { package: packageName } : {}),
    ...(source ? { source } : {}),
  };
}

function normalizeCategories(value: unknown): readonly string[] {
  return [...new Set(normalizeTrimmedStringList(value))];
}

function normalizePreviewCatalog(params: {
  providerId: string;
  value: unknown;
}): ModelCatalogProvider | undefined {
  const catalog = normalizeModelCatalog(
    { providers: { [params.providerId]: params.value } },
    { ownedProviders: new Set([params.providerId]) },
  );
  const provider = catalog?.providers?.[params.providerId];
  if (!provider) {
    return undefined;
  }
  for (const model of provider.models) {
    model.status ??= "preview";
  }
  return provider;
}

function normalizeProvider(
  rawProviderId: string,
  value: unknown,
): OpenClawProviderIndexProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const providerId = normalizeModelCatalogProviderId(rawProviderId);
  if (!providerId) {
    return undefined;
  }
  const id = normalizeModelCatalogProviderId(normalizeOptionalString(value.id) ?? "");
  if (id && id !== providerId) {
    return undefined;
  }
  const name = normalizeOptionalString(value.name) ?? "";
  const plugin = normalizePlugin(value.plugin);
  if (!name || !plugin) {
    return undefined;
  }
  const docs = normalizeOptionalString(value.docs) ?? "";
  const categories = normalizeCategories(value.categories);
  const previewCatalog = normalizePreviewCatalog({
    providerId,
    value: value.previewCatalog,
  });
  return {
    id: providerId,
    name,
    plugin,
    ...(docs ? { docs } : {}),
    ...(categories.length > 0 ? { categories } : {}),
    ...(previewCatalog ? { previewCatalog } : {}),
  };
}

export function normalizeOpenClawProviderIndex(value: unknown): OpenClawProviderIndex | undefined {
  if (!isRecord(value) || value.version !== OPENCLAW_PROVIDER_INDEX_VERSION) {
    return undefined;
  }
  if (!isRecord(value.providers)) {
    return undefined;
  }
  const providers: Record<string, OpenClawProviderIndexProvider> = {};
  for (const [rawProviderId, rawProvider] of Object.entries(value.providers)) {
    const providerId = normalizeModelCatalogProviderId(rawProviderId);
    if (!providerId || isBlockedObjectKey(providerId)) {
      continue;
    }
    const provider = normalizeProvider(providerId, rawProvider);
    if (provider) {
      providers[providerId] = provider;
    }
  }
  return {
    version: OPENCLAW_PROVIDER_INDEX_VERSION,
    providers: Object.fromEntries(
      Object.entries(providers).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  };
}
