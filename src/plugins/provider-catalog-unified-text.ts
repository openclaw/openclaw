import type { UnifiedModelCatalogEntry } from "@openclaw/model-catalog-core/model-catalog-types";
import type { ModelProviderConfig } from "../config/types.js";
import {
  copyArrayEntries,
  copyRecordEntries,
  isRecord,
  readRecordValue,
} from "../shared/safe-record.js";
import type { ProviderCatalogResult } from "./types.js";

function copyProviderCatalogResultEntries(params: {
  providerId: string;
  result: ProviderCatalogResult;
}): Array<[string, ModelProviderConfig]> {
  const provider = readRecordValue(params.result, "provider");
  if (isRecord(provider)) {
    return [[params.providerId, provider as ModelProviderConfig]];
  }
  return copyRecordEntries<ModelProviderConfig>(readRecordValue(params.result, "providers"));
}

function copyProviderModels(providerConfig: ModelProviderConfig): ModelProviderConfig["models"] {
  return copyArrayEntries(readRecordValue(providerConfig, "models")).filter(
    (entry): entry is ModelProviderConfig["models"][number] => isRecord(entry),
  );
}

export function projectProviderCatalogResultToUnifiedTextRows(params: {
  providerId: string;
  result: ProviderCatalogResult;
  source: UnifiedModelCatalogEntry["source"];
}): UnifiedModelCatalogEntry[] {
  const rows: UnifiedModelCatalogEntry[] = [];
  // Runtime projection isolates unreadable catalog rows so one bad plugin-owned
  // provider/model entry cannot hide every healthy sibling from model selection.
  for (const [providerId, providerConfig] of copyProviderCatalogResultEntries(params)) {
    for (const model of copyProviderModels(providerConfig)) {
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
