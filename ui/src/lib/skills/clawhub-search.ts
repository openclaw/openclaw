import type { SkillsSearchResult as ProtocolSkillsSearchResult } from "../../../../packages/gateway-protocol/src/schema/agents-models-skills.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type ClawHubSearchResult = ProtocolSkillsSearchResult["results"][number];
export type ClawHubSkillIdentity = Pick<
  ClawHubSearchResult,
  "slug" | "ownerHandle" | "installRef" | "trustState"
>;

export function clawHubSkillIdentity(result: ClawHubSearchResult): ClawHubSkillIdentity {
  return {
    slug: result.slug,
    ...(result.ownerHandle ? { ownerHandle: result.ownerHandle } : {}),
    ...(result.installRef ? { installRef: result.installRef } : {}),
    ...(result.trustState ? { trustState: result.trustState } : {}),
  };
}

export function clawHubSkillIdentityKey(identity: ClawHubSkillIdentity): string {
  return (
    identity.installRef ??
    (identity.ownerHandle ? `@${identity.ownerHandle}/${identity.slug}` : identity.slug)
  );
}

export function clawHubDetailParams(identity: ClawHubSkillIdentity) {
  return {
    slug: identity.slug,
    ...(identity.ownerHandle ? { ownerHandle: identity.ownerHandle } : {}),
  };
}

export function clawHubInstallParams(identity: ClawHubSkillIdentity) {
  return {
    slug: identity.installRef ?? identity.slug,
    ...(identity.ownerHandle ? { ownerHandle: identity.ownerHandle } : {}),
  };
}

export async function searchClawHub(
  client: GatewayBrowserClient,
  query: string,
  signal?: AbortSignal,
): Promise<ClawHubSearchResult[]> {
  if (!query.trim()) {
    return [];
  }
  const response = await client.request<ProtocolSkillsSearchResult>(
    "skills.search",
    { query, limit: 20 },
    { signal },
  );
  return response?.results ?? [];
}
