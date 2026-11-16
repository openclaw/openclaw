import type {
  ClawHubTemplateCatalogDetail,
  ClawHubTemplateCatalogEntry,
  ClawHubTemplateCatalogPreview,
  ClawHubTemplateCatalogOverview,
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

export async function readTemplatesOverview(
  client: GatewayBrowserClient,
  limit: number,
): Promise<ClawHubTemplateCatalogOverview | undefined> {
  const result = await client.request<{ overview?: ClawHubTemplateCatalogOverview }>(
    "templates.catalog.search",
    { overview: true, limit },
  );
  return result.overview
    ? {
        featured: result.overview.featured.filter(isPublicEntry),
        sections: result.overview.sections.map((section) => ({
          category: section.category,
          entries: section.entries.filter(isPublicEntry),
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
  request: Pick<ClawHubTemplateCatalogPreview, "kind" | "name">,
): Promise<ClawHubTemplateCatalogPreview> {
  const result = await client.request<{ preview: ClawHubTemplateCatalogPreview }>(
    "templates.catalog.preview",
    { ...source, ...request },
  );
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
      ...(options.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
    },
    { onSent: options.onSent },
  );
}
