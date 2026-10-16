import type {
  ClawPluginAcknowledgement,
  ClawSkillAcknowledgement,
  ClawLifecyclePlanResult,
} from "../../../../packages/gateway-protocol/src/schema/claws.js";
import type {
  ClawHubClawCatalogDetail,
  ClawHubClawCatalogEntry,
  ClawHubClawCatalogPreview,
} from "../../../../src/claws/clawhub-source.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type ClawCatalogEntry = ClawHubClawCatalogEntry;
export type ClawCatalogDetail = ClawHubClawCatalogDetail;
export type ClawCatalogSource = { packageName: string; version: string };
export type ClawAddReviewPlan = ClawLifecyclePlanResult;

export type ClawAddApplyResult = {
  agentId: string;
  status: string;
  readiness: { ready: boolean; requirements?: Array<{ kind: string; owner: string }> };
  error?: { code: string; message: string };
};

function isOfficialEntry(entry: ClawCatalogEntry): boolean {
  return (
    entry.official && entry.channel === "official" && entry.packageName.startsWith("@openclaw/")
  );
}

export async function searchOfficialClaws(
  client: GatewayBrowserClient,
  query: string,
  limit?: number,
): Promise<ClawCatalogEntry[]> {
  const trimmed = query.trim();
  const result = await client.request<{ entries: ClawCatalogEntry[] }>("claws.catalog.search", {
    ...(trimmed ? { query: trimmed } : {}),
    ...(limit ? { limit } : {}),
  });
  return result.entries.filter(isOfficialEntry);
}

export async function readOfficialClawDetail(
  client: GatewayBrowserClient,
  source: ClawCatalogSource,
): Promise<ClawCatalogDetail> {
  const result = await client.request<{ detail: ClawCatalogDetail }>(
    "claws.catalog.detail",
    source,
  );
  const detail = result.detail;
  if (
    !isOfficialEntry(detail) ||
    detail.packageName !== source.packageName ||
    detail.version !== source.version ||
    !detail.contents ||
    !Array.isArray(detail.contents.instructions) ||
    !Array.isArray(detail.contents.skills) ||
    !Array.isArray(detail.contents.integrations) ||
    !Array.isArray(detail.contents.automations)
  ) {
    throw new Error("ClawHub did not return the contents of this Claw release.");
  }
  return detail;
}

export async function readOfficialClawPreview(
  client: GatewayBrowserClient,
  source: ClawCatalogSource,
  request: Pick<ClawHubClawCatalogPreview, "kind" | "name">,
): Promise<ClawHubClawCatalogPreview> {
  const result = await client.request<{ preview: ClawHubClawCatalogPreview }>(
    "claws.catalog.preview",
    { ...source, ...request },
  );
  if (result.preview.kind !== request.kind || result.preview.name !== request.name) {
    throw new Error("ClawHub returned a different preview item.");
  }
  return result.preview;
}

export async function readOfficialClawAddReviewPlan(
  client: GatewayBrowserClient,
  source: ClawCatalogSource,
): Promise<ClawAddReviewPlan> {
  const plan = await client.request<ClawLifecyclePlanResult>("claws.add.plan", { source });
  if (plan.operation !== "add" || !plan.planIntegrity) {
    throw new Error("ClawHub did not return a valid Add review.");
  }
  return plan;
}

export async function applyOfficialClawAdd(
  client: GatewayBrowserClient,
  source: ClawCatalogSource,
  options: {
    acknowledgeClawHubRisk?: boolean;
    reviewPlan?: ClawAddReviewPlan;
  } = {},
): Promise<ClawAddApplyResult> {
  const plan = options.reviewPlan;
  return await client.request<ClawAddApplyResult>("claws.add.apply", {
    source,
    ...(options.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
    ...(plan
      ? {
          planIntegrity: plan.planIntegrity,
          acknowledgeCapabilities: plan.pluginReviews
            .filter((review) => review.ownerAction === "install")
            .map((review): ClawPluginAcknowledgement => ({
              actionId: review.actionId,
              pluginId: review.pluginId,
              reviewToken: review.reviewToken,
              capabilityGrants: review.capabilityGrants,
              capabilityGrantsByPluginId: review.capabilityGrantsByPluginId,
              acknowledgeRiskWarning: review.riskWarning ? true : undefined,
            })),
          acknowledgeSkillWarnings: plan.skillReviews.map((review): ClawSkillAcknowledgement => ({
            actionId: review.actionId,
            ref: review.ref,
            reviewToken: review.reviewToken,
            acknowledgeRiskWarning: true,
          })),
        }
      : {}),
  });
}
