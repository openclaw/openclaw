import type {
  ClawHubTemplateCatalogDetail,
  ClawHubTemplateCatalogEntry,
} from "../../../../src/templates/clawhub-source.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { inspection } from "../../e2e/plugins-settings-admin.test-support.ts";
import { sourceConfigSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";

export const workflowOperator = {
  packageName: "@openclaw/workflow-operator",
  displayName: "Workflow Operator",
  summary: "Runs approved work across your tools.",
  latestVersion: "1.2.0",
  channel: "official",
  official: true,
  ownerHandle: "openclaw",
  downloads: 1200,
  installs: 200,
  updatedAtMs: 1_790_000_000_000,
} satisfies ClawHubTemplateCatalogEntry;
export const summaryFreeTemplate: ClawHubTemplateCatalogEntry = { ...workflowOperator };
delete summaryFreeTemplate.summary;
export const researchTemplate = {
  ...workflowOperator,
  packageName: "@maker/release-scout",
  displayName: "Release Scout",
};
export const auditUrl = "https://clawhub.ai/openclaw/templates/workflow-operator/security-audit";
export const publishedAtMs = 1_780_000_000_000;
export const soulExcerpt = "Keep the owner informed about approved workflows. ".repeat(24);
export const skillExcerpt =
  "Research trips and compare destinations against the approved itinerary. ".repeat(24);
const config = { gateway: { controlUi: { experimental: { templates: true } } } };
export const agentsList = makeBootRoster({ agents: [{ id: "main", name: "Main" }] });

export function templateCatalogReplies(
  entry: ClawHubTemplateCatalogEntry,
  detailPublisher: Partial<Pick<ClawHubTemplateCatalogEntry, "ownerHandle" | "official">>,
  catalogEntries: ClawHubTemplateCatalogEntry[],
) {
  return {
    "plugins.catalog.get": {
      ...inspection.catalog,
      plugin: {
        ...inspection.catalog.plugin,
        local: {
          present: false,
          installed: false,
          enabled: false,
          state: "not-installed",
          action: "install",
        },
      },
    } satisfies PluginDiscoveryDetailResult,
    "config.get": sourceConfigSnapshot(config),
    "agents.list": agentsList,
    "templates.catalog.search": { entries: catalogEntries },
    "templates.catalog.detail": {
      detail: {
        ...entry,
        ...detailPublisher,
        version: "1.2.0",
        agentId: "workflow-operator",
        agentName: "Workflow Operator",
        workspaceFiles: 2,
        skills: 1,
        plugins: 1,
        mcpServers: 0,
        scheduledJobs: 0,
        createdAtMs: publishedAtMs,
        categories: ["research", "productivity"],
        security: { verdict: "benign", auditUrl },
        contents: {
          instructions: [
            { name: "SOUL.md", source: "workspace/SOUL.md", excerpt: soulExcerpt },
            { name: "AGENTS.md", source: "workspace/AGENTS.md" },
          ],
          skills: [
            {
              name: "Trip research",
              source: "clawhub",
              ref: "@openclaw/trip-research",
              version: "2.0.0",
              excerpt: skillExcerpt,
            },
          ],
          integrations: [
            {
              name: "@openclaw/workflow-tools",
              kind: "plugin",
              source: "clawhub",
              ref: "@openclaw/workflow-tools",
              version: "1.2.0",
            },
          ],
          automations: [],
        },
      } satisfies ClawHubTemplateCatalogDetail,
    },
    "plugins.list": {
      plugins: [
        {
          id: "workflow-tools",
          name: "Workflow Tools",
          packageName: "@openclaw/workflow-tools",
          clawhubPackage: "@openclaw/workflow-tools",
          version: "1.2.0",
          installed: true,
          enabled: true,
          state: "enabled",
        },
      ],
      diagnostics: [],
      mutationAllowed: true,
    },
    "templates.add.apply": {
      agentId: "workflow-operator",
      status: "complete",
      readiness: { ready: false, requirements: [{ kind: "oauth", owner: "workflows" }] },
    },
  };
}
