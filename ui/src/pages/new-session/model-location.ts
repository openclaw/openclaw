import {
  buildModelCatalogRef,
  parseModelCatalogRef,
} from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  newSessionLocationFromSearch,
  newSessionSearch,
  type NewSessionRouteData,
} from "./location.ts";

function requestedModel(value: string | null): string | undefined {
  if (
    !value ||
    value.length > 2048 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    return undefined;
  }
  const parsed = parseModelCatalogRef(value);
  return parsed ? buildModelCatalogRef(parsed.provider, parsed.modelId) : undefined;
}

export function newSessionModelSearch(agentId: string, model: string): string {
  const params = new URLSearchParams(newSessionSearch(agentId));
  const validatedModel = requestedModel(model);
  if (validatedModel) {
    params.set("model", validatedModel);
  }
  return params.size > 0 ? `?${params.toString()}` : "";
}

export function newSessionModelLocationFromSearch(
  search: string,
): Pick<NewSessionRouteData, "agentId" | "catalogId" | "group" | "requestedModel"> {
  const location = newSessionLocationFromSearch(search);
  const model = location.catalogId
    ? undefined
    : requestedModel(new URLSearchParams(search).get("model"));
  return { ...location, ...(model ? { requestedModel: model } : {}) };
}
