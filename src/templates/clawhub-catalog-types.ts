// Shapes the public Template catalog projects from ClawHub listings and exact releases.
import type { TemplatesCatalogDetailResult } from "../../packages/gateway-protocol/src/schema/templates.js";

export type ClawHubTemplateCatalogEntry = {
  packageName: string;
  displayName: string;
  summary?: string;
  iconUrl?: string;
  latestVersion?: string;
  channel: "official" | "community";
  official: boolean;
  ownerHandle: string;
  downloads: number;
  installs: number;
  featuredAt?: number;
  updatedAtMs: number;
};
export type ClawHubTemplateCatalogOverview = {
  featured: ClawHubTemplateCatalogEntry[];
  sections: Array<{
    category: string;
    entries: ClawHubTemplateCatalogEntry[];
    /** Present (even if empty) only when the registry supplied the whole category. */
    additionalEntries?: ClawHubTemplateCatalogEntry[];
  }>;
};
export type ClawHubTemplateCatalogDetail = ClawHubTemplateCatalogEntry & {
  version: string;
  /** The Template's own agent id; Add derives the new agent's id from it. */
  agentId: string;
  agentName?: string;
  agentDescription?: string;
  workspaceFiles: number;
  skills: number;
  plugins: number;
  mcpServers: number;
  scheduledJobs: number;
  contents: NonNullable<TemplatesCatalogDetailResult["detail"]["contents"]>;
  createdAtMs?: number;
  categories?: string[];
  security?: NonNullable<TemplatesCatalogDetailResult["detail"]["security"]>;
};
