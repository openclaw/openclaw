import type { UnifiedModelCatalogEntry } from "@openclaw/model-catalog-core/model-catalog-types";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { ProviderCatalogResult } from "./types.js";

function isReadableRecord(value: unknown): value is Record<string, unknown> {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function readRecordValue(value: unknown, key: string): unknown {
  if (!isReadableRecord(value)) {
    return undefined;
  }
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function copyArrayEntries(value: unknown): unknown[] {
  try {
    if (!Array.isArray(value)) {
      return [];
    }
    const entries: unknown[] = [];
    for (const index of value.keys()) {
      try {
        entries.push(value[index]);
      } catch {
        continue;
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function copyProviderEntries(params: {
  providerId: string;
  result: ProviderCatalogResult;
}): Array<[string, ModelProviderConfig]> {
  const provider = readRecordValue(params.result, "provider");
  if (isReadableRecord(provider)) {
    return [[params.providerId, provider as ModelProviderConfig]];
  }

  const providers = readRecordValue(params.result, "providers");
  if (!isReadableRecord(providers)) {
    return [];
  }

  let providerIds: string[];
  try {
    providerIds = Object.keys(providers);
  } catch {
    return [];
  }

  const entries: Array<[string, ModelProviderConfig]> = [];
  for (const providerId of providerIds) {
    const providerConfig = readRecordValue(providers, providerId);
    if (isReadableRecord(providerConfig)) {
      entries.push([providerId, providerConfig as ModelProviderConfig]);
    }
  }
  return entries;
}

export function projectProviderCatalogResultToUnifiedTextRows(params: {
  providerId: string;
  result: ProviderCatalogResult;
  source: UnifiedModelCatalogEntry["source"];
}): UnifiedModelCatalogEntry[] {
  const rows: UnifiedModelCatalogEntry[] = [];
  for (const [providerId, providerConfig] of copyProviderEntries(params)) {
    for (const model of copyArrayEntries(readRecordValue(providerConfig, "models"))) {
      const modelId = readRecordValue(model, "id");
      if (typeof modelId !== "string") {
        continue;
      }
      const modelName = readRecordValue(model, "name");
      rows.push({
        kind: "text",
        provider: providerId,
        model: modelId,
        ...(typeof modelName === "string" && modelName ? { label: modelName } : {}),
        source: params.source,
      });
    }
  }
  return rows;
}
