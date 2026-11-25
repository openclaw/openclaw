import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SkillsCategoriesResult } from "../../packages/gateway-protocol/src/schema/skills-search.js";
import {
  ClawHubRequestError,
  fetchClawHubJson,
  isDefaultClawHubBaseUrl,
  readClawHubStringField,
  readRequiredClawHubStringField,
  type ClawHubFetchOptions,
} from "./clawhub-client.js";

export async function fetchClawHubSkillCategories(
  params: ClawHubFetchOptions = {},
): Promise<SkillsCategoriesResult> {
  let value: unknown;
  try {
    value = await fetchClawHubJson<unknown>({
      ...params,
      path: "/api/v1/skills/-/categories",
      skipAuth: !params.token && isDefaultClawHubBaseUrl(params.baseUrl),
    });
  } catch (error) {
    if (error instanceof ClawHubRequestError && error.status === 404) {
      return { categories: [] };
    }
    throw error;
  }
  if (!isRecord(value) || !Array.isArray(value.categories)) {
    throw new Error("Malformed ClawHub skill categories: expected a category array.");
  }
  return {
    categories: value.categories.map((row) => {
      if (!isRecord(row)) {
        throw new Error("Malformed ClawHub skill category: expected an object.");
      }
      return {
        slug: readRequiredClawHubStringField(row, "slug", "skill category"),
        label: readRequiredClawHubStringField(row, "label", "skill category"),
        description: readClawHubStringField(row, "description", "skill category") || undefined,
        icon: readClawHubStringField(row, "icon", "skill category") || undefined,
      };
    }),
  };
}
