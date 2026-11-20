import type {
  TemplateLifecyclePlanResult,
  TemplatePluginAcknowledgement,
  TemplateSkillAcknowledgement,
} from "@openclaw/gateway-protocol";
import type { ClawHubTemplateCatalogOverview } from "../../../../src/templates/clawhub-catalog-types.js";
import type {
  ClawHubTemplateCatalogDetail,
  ClawHubTemplateCatalogEntry,
  ClawHubTemplateCatalogPreview,
} from "../../../../src/templates/clawhub-source.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export type TemplateCatalogEntry = ClawHubTemplateCatalogEntry;
export type TemplateCatalogDetail = ClawHubTemplateCatalogDetail;
export type TemplateCatalogSource = { packageName: string; version: string };

export type TemplateAddApplyResult = {
  agentId: string;
  status: "complete" | "partial";
  agentRetained?: true;
  initializationPending?: true;
  sessionKey?: string;
  readiness: { ready: boolean; requirements?: Array<{ kind: string; owner: string }> };
  error?: { code: string; message: string };
};

function isPublicEntry(entry: TemplateCatalogEntry): boolean {
  return entry.channel === "official" || entry.channel === "community";
}

const TEMPLATE_SEARCH_PAGE_SIZE = 20;

export async function searchTemplates(
  client: GatewayBrowserClient,
  query: string,
  options: { category?: string; featured?: boolean; limit?: number; cursor?: string } = {},
): Promise<{ entries: TemplateCatalogEntry[]; nextCursor?: string | null }> {
  const trimmed = query.trim();
  const result = await client.request<{
    entries: TemplateCatalogEntry[];
    nextCursor?: string | null;
  }>("templates.catalog.search", {
    ...(trimmed ? { query: trimmed } : {}),
    limit: options.limit ?? TEMPLATE_SEARCH_PAGE_SIZE,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.featured ? { featured: true } : {}),
    ...(options.category ? { category: options.category } : {}),
  });
  return { entries: result.entries.filter(isPublicEntry), nextCursor: result.nextCursor };
}

export async function readTemplatesOverview(
  client: GatewayBrowserClient,
  limit: number,
): Promise<ClawHubTemplateCatalogOverview | undefined> {
  const result = await client.request<{ overview?: ClawHubTemplateCatalogOverview }>(
    "templates.catalog.search",
    { overview: true, limit, includeCategoryEntries: true },
  );
  return result.overview
    ? {
        featured: result.overview.featured.filter(isPublicEntry),
        sections: result.overview.sections.map((section) => ({
          category: section.category,
          entries: section.entries.filter(isPublicEntry),
          additionalEntries: section.additionalEntries?.filter(isPublicEntry),
        })),
      }
    : undefined;
}

export async function readTemplateDetail(
  client: GatewayBrowserClient,
  source: { packageName: string; version?: string },
): Promise<TemplateCatalogDetail> {
  const result = await client.request<{ detail: TemplateCatalogDetail }>(
    "templates.catalog.detail",
    source,
  );
  const detail = result.detail;
  if (
    !isPublicEntry(detail) ||
    detail.packageName !== source.packageName ||
    (source.version !== undefined && detail.version !== source.version) ||
    !detail.agentId ||
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
  request: Pick<ClawHubTemplateCatalogPreview, "kind" | "name"> & { automationIndex?: number },
): Promise<ClawHubTemplateCatalogPreview> {
  const result = await client.request<{ preview: ClawHubTemplateCatalogPreview }>(
    "templates.catalog.preview",
    { ...source, ...request },
  );
  if (result.preview.kind !== request.kind || result.preview.name !== request.name) {
    throw new Error("ClawHub returned a different Template preview.");
  }
  return result.preview;
}

/**
 * Chat-based Add: the Gateway creates the agent without a reviewed plan and the
 * agent's own conversation continues setup. `agentId` is the id this client
 * wants; the result names the unused id the Gateway chose. An error response
 * means no agent or chat was kept.
 */
export async function applyTemplateAdd(
  client: GatewayBrowserClient,
  source: TemplateCatalogSource,
  options: {
    agentId: string;
    resume?: true;
    acknowledgeClawHubRisk?: boolean;
    onSent?: (requestId: string) => void;
  },
): Promise<TemplateAddApplyResult> {
  return await client.request<TemplateAddApplyResult>(
    "templates.add.apply",
    {
      mode: "chat",
      source,
      agentId: options.agentId,
      ...(options.resume ? { resume: true } : {}),
      ...(options.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
    },
    { onSent: options.onSent },
  );
}

export type TemplateUploadSource = { kind: "upload"; archiveBase64: string };
export type TemplateAddReviewPlan = TemplateLifecyclePlanResult & {
  reviewFiles: NonNullable<TemplateLifecyclePlanResult["reviewFiles"]>;
};

export async function readTemplateAddReviewPlan(
  client: GatewayBrowserClient,
  source: TemplateUploadSource,
): Promise<TemplateAddReviewPlan> {
  const plan = await client.request<TemplateLifecyclePlanResult>("templates.add.plan", { source });
  if (plan.operation !== "add" || !plan.planIntegrity || !Array.isArray(plan.reviewFiles)) {
    throw new Error("Gateway did not return a valid Add review.");
  }
  return { ...plan, reviewFiles: plan.reviewFiles };
}

/** Local archives always apply the exact reviewed plan, never chat-based Add. */
export async function applyTemplateUpload(
  client: GatewayBrowserClient,
  source: TemplateUploadSource,
  plan: TemplateAddReviewPlan,
): Promise<TemplateAddApplyResult> {
  return await client.request<TemplateAddApplyResult>("templates.add.apply", {
    source,
    planIntegrity: plan.planIntegrity,
    ...(plan.riskAcknowledgementRequired ? { acknowledgeClawHubRisk: true } : {}),
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
    acknowledgeSkillWarnings: plan.skillReviews.map((review): TemplateSkillAcknowledgement =>
      "path" in review
        ? {
            actionId: review.actionId,
            source: "bundled",
            path: review.path,
            digest: review.digest,
            reviewToken: review.reviewToken,
            acknowledgeRiskWarning: true,
          }
        : {
            actionId: review.actionId,
            source: "clawhub",
            ref: review.ref,
            reviewToken: review.reviewToken,
            acknowledgeRiskWarning: true,
          },
    ),
  });
}
