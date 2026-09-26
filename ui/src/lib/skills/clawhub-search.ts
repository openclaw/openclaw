import type { SkillsSearchResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type ClawHubSearchResult = Omit<SkillsSearchResult["results"][number], "installRef"> & {
  installRef?: string;
};

/**
 * Reference the operator actually picked. Several publishers can share one slug, and ClawHub
 * answers a bare slug with 409 AMBIGUOUS_SKILL_SLUG, so install must send this.
 * Gateways older than the installRef contract only supply the slug.
 */
export function clawHubSkillRef(result: ClawHubSearchResult): string {
  return result.installRef ?? result.slug;
}

export async function searchClawHub(
  client: GatewayBrowserClient,
  query: string,
  signal?: AbortSignal,
): Promise<ClawHubSearchResult[]> {
  const response = await client.request<{ results: ClawHubSearchResult[] }>(
    "skills.search",
    { query: query.trim() || undefined, limit: 20 },
    { signal },
  );
  return response?.results ?? [];
}
