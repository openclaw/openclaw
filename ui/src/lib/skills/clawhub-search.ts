import type {
  SkillsCategoriesResult,
  SkillsSearchParams,
  SkillsSearchResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { CATALOG_INITIAL_PAGE_SIZE, CATALOG_NEXT_PAGE_SIZE } from "../catalog-page-size.ts";
import { formatUiError } from "../format-error.ts";

export type ClawHubSearchResult = SkillsSearchResult["results"][number];

export async function searchClawHub(
  client: GatewayBrowserClient,
  params: SkillsSearchParams,
  signal?: AbortSignal,
): Promise<SkillsSearchResult> {
  return client.request<SkillsSearchResult>(
    "skills.search",
    {
      ...params,
      query: params.query?.trim() || undefined,
      limit: params.cursor ? CATALOG_NEXT_PAGE_SIZE : CATALOG_INITIAL_PAGE_SIZE,
    },
    { signal },
  );
}

export type SkillCategoryDirectory = SkillsCategoriesResult & { error?: string };

export async function loadSkillCategories(
  client: GatewayBrowserClient,
): Promise<SkillCategoryDirectory> {
  try {
    return await client.request<SkillsCategoriesResult>("skills.categories", {
      includePreviews: true,
    });
  } catch (error) {
    // The optional taxonomy must not hold a usable, independently ranked feed.
    return { categories: [], error: formatUiError(error) };
  }
}
