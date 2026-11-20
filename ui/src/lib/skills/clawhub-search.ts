import type {
  SkillsCategoriesResult,
  SkillsSearchParams,
  SkillsSearchResult,
} from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type ClawHubSearchResult = SkillsSearchResult["results"][number];

export async function searchClawHub(
  client: GatewayBrowserClient,
  params: SkillsSearchParams,
  signal?: AbortSignal,
): Promise<SkillsSearchResult> {
  return client.request<SkillsSearchResult>(
    "skills.search",
    { ...params, query: params.query?.trim() || undefined, limit: 20 },
    { signal },
  );
}

export function loadSkillCategories(client: GatewayBrowserClient) {
  return client.request<SkillsCategoriesResult>("skills.categories", {});
}
