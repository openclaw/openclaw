import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";

export type ModelsListEntry = Pick<
  ModelCatalogEntry,
  "alias" | "contextWindow" | "id" | "input" | "name" | "provider" | "reasoning"
> & { available?: boolean; supportsTools?: boolean };

function resolvePositiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// Project explicitly onto the public protocol shape. Concrete route, base URL,
// auth, and cost facts stay private; runtime intent is attached separately.
export function buildPublicModelProjection(entry: ModelCatalogEntry): ModelsListEntry {
  const contextWindow = resolvePositiveSafeInteger(entry.contextWindow);
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    ...(entry.alias ? { alias: entry.alias } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
    ...(typeof entry.compat?.supportsTools === "boolean"
      ? { supportsTools: entry.compat.supportsTools }
      : {}),
  };
}
