import type { SkillsSearchResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type ClawHubSearchResult = SkillsSearchResult["results"][number];

export async function searchClawHub(
  client: GatewayBrowserClient,
  query: string,
  signal?: AbortSignal,
): Promise<ClawHubSearchResult[]> {
  const response = await client.request<SkillsSearchResult>(
    "skills.search",
    { query: query.trim() || undefined, limit: 20 },
    { signal },
  );
  return response?.results ?? [];
}
