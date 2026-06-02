import type { UnifiedModelCatalogEntry } from "@openclaw/model-catalog-core/model-catalog-types";
import { readRecordValue } from "../shared/safe-record.js";
import {
  copyProviderCatalogModels,
  copyProviderCatalogResultEntries,
} from "./provider-catalog-result.js";
import type { ProviderCatalogResult } from "./types.js";

/**
 * Projects a provider plugin catalog result into unified text model rows.
 *
 * Malformed provider/model entries are skipped instead of throwing so one bad
 * plugin-owned catalog row cannot hide healthy siblings from model selection.
 */
export function projectProviderCatalogResultToUnifiedTextRows(params: {
  providerId: string;
  result: ProviderCatalogResult;
  source: UnifiedModelCatalogEntry["source"];
}): UnifiedModelCatalogEntry[] {
  const rows: UnifiedModelCatalogEntry[] = [];
  for (const [providerId, providerConfig] of copyProviderCatalogResultEntries(params)) {
    for (const model of copyProviderCatalogModels(providerConfig)) {
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
