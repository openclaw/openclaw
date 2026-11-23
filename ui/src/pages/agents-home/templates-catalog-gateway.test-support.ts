import type { Browser, Page } from "playwright";
import { onTestFinished } from "vitest";
import type {
  ClawHubTemplateCatalogDetail,
  ClawHubTemplateCatalogEntry,
} from "../../../../src/templates/clawhub-source.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { inspection } from "../../e2e/plugins-settings-admin.test-support.ts";
import { sourceConfigSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import {
  createControlUiMockSameOriginGatewayScript,
  installMockGateway,
} from "../../test-helpers/control-ui-e2e.ts";

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
export const auditUrl = "https://clawhub.ai/openclaw/templates/workflow-operator/security-audit";
export const publishedAtMs = 1_780_000_000_000;
export const soulExcerpt = "Keep the owner informed about approved workflows. ".repeat(24);
export const skillExcerpt =
  "Research trips and compare destinations against the approved itinerary. ".repeat(24);
const config = { gateway: { controlUi: { experimental: { templates: true } } } };
export const agentsList = makeBootRoster({ agents: [{ id: "main", name: "Main" }] });

export function createTemplateCatalogFixture(runtime: () => { browser: Browser; baseUrl: string }) {
  return async function fixture(
    viewport = { width: 1440, height: 900 },
    entry: ClawHubTemplateCatalogEntry = workflowOperator,
    detailPublisher: Partial<Pick<ClawHubTemplateCatalogEntry, "ownerHandle" | "official">> = {},
    loading = false,
    colorScheme: "light" | "dark" = "light",
    linkPreviews = false,
    catalogEntries: ClawHubTemplateCatalogEntry[] = [entry],
  ) {
    const { browser, baseUrl } = runtime();
    const context = await browser.newContext({
      colorScheme,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: viewport.width, height: viewport.height },
    });
    onTestFinished(() => context.close());
    const page = await context.newPage();
    const gateway = await installTemplateCatalogGateway(page, {
      entry,
      detailPublisher,
      loading,
      linkPreviews,
      catalogEntries,
    });
    await page.goto(`${baseUrl}templates`);
    return { page, gateway };
  };
}

async function installTemplateCatalogGateway(
  page: Page,
  options: {
    entry: ClawHubTemplateCatalogEntry;
    detailPublisher: Partial<Pick<ClawHubTemplateCatalogEntry, "ownerHandle" | "official">>;
    loading: boolean;
    linkPreviews: boolean;
    catalogEntries: ClawHubTemplateCatalogEntry[];
  },
) {
  const { entry, detailPublisher, loading, linkPreviews, catalogEntries } = options;
  await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
  return installMockGateway(page, {
    automaticallyFetchFavicons: linkPreviews,
    historyMessages: [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Try [Workflow Operator](/templates/packages/%40openclaw%2Fworkflow-operator) or [another reference](/templates/packages/%40openclaw%2Fworkflow-operator).",
          },
        ],
      },
    ],
    heldMethods: loading ? ["templates.catalog.search"] : [],
    featureMethods: [
      "openclaw.chat",
      "templates.catalog.search",
      "templates.catalog.detail",
      "templates.catalog.preview",
      "templates.add.apply",
      "plugins.list",
      "plugins.catalog.get",
    ],
    methodResponses: {
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
      "templates.catalog.search": {
        entries: [entry],
        overview: {
          featured: catalogEntries,
          sections: [{ category: "research", entries: catalogEntries }],
        },
      },
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
    },
  });
}
