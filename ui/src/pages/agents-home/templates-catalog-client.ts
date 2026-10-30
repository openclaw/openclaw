import type {
  TemplatePluginAcknowledgement,
  TemplateSkillAcknowledgement,
  TemplateLifecyclePlanResult,
} from "../../../../packages/gateway-protocol/src/schema/templates.js";
import type {
  ClawHubTemplateCatalogDetail,
  ClawHubTemplateCatalogEntry,
  ClawHubTemplateCatalogPreview,
} from "../../../../src/templates/clawhub-source.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type TemplateCatalogEntry = ClawHubTemplateCatalogEntry;
export type TemplateCatalogDetail = ClawHubTemplateCatalogDetail;
export type TemplateCatalogSource = { packageName: string; version: string };
export type TemplateAddReviewPlan = TemplateLifecyclePlanResult;

export type TemplateAddApplyResult = {
  agentId: string;
  status: string;
  readiness: { ready: boolean; requirements?: Array<{ kind: string; owner: string }> };
  error?: { code: string; message: string };
};

function isPublicEntry(entry: TemplateCatalogEntry): boolean {
  return entry.channel === "official" || entry.channel === "community";
}

export async function searchTemplates(
  client: GatewayBrowserClient,
  query: string,
  limit?: number,
  options: { category?: string; featured?: boolean } = {},
): Promise<TemplateCatalogEntry[]> {
  const trimmed = query.trim();
  const result = await client.request<{ entries: TemplateCatalogEntry[] }>(
    "templates.catalog.search",
    {
      ...(trimmed ? { query: trimmed } : {}),
      ...(limit ? { limit } : {}),
      ...(options.category ? { category: options.category } : {}),
      ...(options.featured ? { featured: true } : {}),
    },
  );
  return result.entries.filter(isPublicEntry);
}

export async function readTemplateDetail(
  client: GatewayBrowserClient,
  source: TemplateCatalogSource,
): Promise<TemplateCatalogDetail> {
  const result = await client.request<{ detail: TemplateCatalogDetail }>(
    "templates.catalog.detail",
    source,
  );
  const detail = result.detail;
  if (
    !isPublicEntry(detail) ||
    detail.packageName !== source.packageName ||
    detail.version !== source.version ||
    !detail.contents ||
    !Array.isArray(detail.contents.instructions) ||
    !Array.isArray(detail.contents.skills) ||
    !Array.isArray(detail.contents.integrations) ||
    !Array.isArray(detail.contents.automations)
  ) {
    throw new Error("ClawHub did not return the contents of this Template release.");
  }
  return detail;
}

export async function readTemplatePreview(
  client: GatewayBrowserClient,
  source: TemplateCatalogSource,
  request: Pick<ClawHubTemplateCatalogPreview, "kind" | "name">,
): Promise<ClawHubTemplateCatalogPreview> {
  const result = await client.request<{ preview: ClawHubTemplateCatalogPreview }>(
    "templates.catalog.preview",
    { ...source, ...request },
  );
  return result.preview;
}

export async function readTemplateAddReviewPlan(
  client: GatewayBrowserClient,
  source: TemplateCatalogSource,
): Promise<TemplateAddReviewPlan> {
  const plan = await client.request<TemplateLifecyclePlanResult>("templates.add.plan", { source });
  if (plan.operation !== "add" || !plan.planIntegrity) {
    throw new Error("ClawHub did not return a valid Add review.");
  }
  return plan;
}

export async function applyTemplateAdd(
  client: GatewayBrowserClient,
  source: TemplateCatalogSource,
  options: {
    acknowledgeClawHubRisk?: boolean;
    reviewPlan?: TemplateAddReviewPlan;
  } = {},
): Promise<TemplateAddApplyResult> {
  const plan = options.reviewPlan;
  return await client.request<TemplateAddApplyResult>("templates.add.apply", {
    source,
    ...(options.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
    ...(plan
      ? {
          planIntegrity: plan.planIntegrity,
          acknowledgeCapabilities: plan.pluginReviews
            .filter((review) => review.ownerAction === "install")
            .map((review): TemplatePluginAcknowledgement => ({
              actionId: review.actionId,
              pluginId: review.pluginId,
              reviewToken: review.reviewToken,
              capabilityGrants: review.capabilityGrants,
              capabilityGrantsByPluginId: review.capabilityGrantsByPluginId,
              acknowledgeRiskWarning: review.riskWarning ? true : undefined,
            })),
          acknowledgeSkillWarnings: plan.skillReviews.map(
            (review): TemplateSkillAcknowledgement => ({
              actionId: review.actionId,
              ref: review.ref,
              reviewToken: review.reviewToken,
              acknowledgeRiskWarning: true,
            }),
          ),
        }
      : {}),
  });
}
