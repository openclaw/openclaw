import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const browserAvailable = canRunPlaywrightChromium(executablePath);
const capture = process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1";
const pluginIntegrity = `sha256-${"A".repeat(43)}=`;
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const workflowOperator = {
  packageName: "@openclaw/workflow-operator",
  displayName: "Workflow Operator",
  summary: "Runs approved work across your tools.",
  latestVersion: "1.2.0",
  channel: "official",
  official: true,
  downloads: 12,
  updatedAtMs: 1_000,
};
const starterClaws = [
  workflowOperator,
  ...Array.from({ length: 29 }, (_, index) => ({
    ...workflowOperator,
    packageName: `@openclaw/starter-${index + 1}`,
    displayName: `Starter ${index + 1}`,
    summary: `A focused starter for task ${index + 1}.`,
  })),
];

let browser: Browser;
let server: ControlUiE2eServer;

describe.skipIf(!browserAvailable)("Claws catalog in Agents", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(viewports)("shows Explore and review at $name width", async (viewport) => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();
    const config = { gateway: { controlUi: { experimental: { claws: true } } } };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "openclaw.chat",
        "claws.catalog.search",
        "claws.catalog.detail",
        "claws.add.plan",
        "claws.add.apply",
      ],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          resolved: config,
          raw: JSON.stringify(config),
          hash: "claws-e2e-config",
          path: "/tmp/openclaw-claws-e2e.json",
          valid: true,
          issues: [],
        },
        "claws.catalog.search": {
          cases: [
            { match: { query: "Workflow" }, response: { entries: [workflowOperator] } },
            { response: { entries: starterClaws } },
          ],
        },
        "claws.catalog.detail": {
          detail: {
            ...workflowOperator,
            version: "1.2.0",
            agentName: "Workflow Operator",
            workspaceFiles: 3,
            skills: 1,
            plugins: 1,
            mcpServers: 0,
            scheduledJobs: 0,
          },
        },
        "claws.add.plan": {
          schemaVersion: "openclaw.clawsGatewayPlan.v1",
          operation: "add",
          planIntegrity: "sha256:reviewed-plan",
          target: {
            agentId: "workflow-operator",
            name: "Workflow Operator",
            targetVersion: "1.2.0",
          },
          actions: [
            {
              kind: "agent",
              id: "workflow-operator",
              action: "create",
              blocked: false,
              details: ["Creates a dedicated workspace"],
            },
            {
              kind: "workspaceFile",
              id: "SOUL.md",
              action: "write",
              blocked: false,
              effect: {
                type: "workspace-file",
                destination: "workspace/SOUL.md",
                source: "package/SOUL.md",
                desiredDigest: "sha256:starter-soul",
              },
            },
            {
              kind: "plugin",
              id: "workflow-tools",
              action: "install",
              blocked: false,
              details: ["Installs workflow-tools@1.2.0"],
            },
          ],
          capabilities: [
            {
              kind: "plugin",
              id: "workflow-tools",
              action: "install",
              reason: "Run approved workflows",
              grants: ["files:read", "network:send"],
              details: ["Uses a local workflow plugin"],
            },
          ],
          blockers: [],
          skillReviews: [],
          pluginReviews: [
            {
              actionId: "package:workflow-tools",
              pluginId: "workflow-tools",
              ref: "@openclaw/workflow-tools",
              version: "1.2.0",
              ownerAction: "install",
              integrity: pluginIntegrity,
              declaredCapabilities: {
                channels: [],
                providers: [],
                tools: ["workflow.start"],
                contracts: [],
                hooks: [],
                mcpServers: [],
                cliCommands: [],
                cliBackends: [],
                skills: [],
                dangerousConfigFlags: [],
              },
              capabilityGrants: {
                hooks: {
                  allowPromptInjection: { effective: false },
                  allowConversationAccess: { effective: true },
                },
              },
              reviewToken: "review-workflow-tools",
            },
          ],
          riskAcknowledgementRequired: false,
          trustWarning: `ClawHub security audit ${"-".repeat(160)} review the release before Add.`,
          configuredAccess: {
            coverage: "configuration-only",
            desired: {
              tools: {
                allowed: ["read", "workflow.start"],
                excluded: ["exec"],
                explicitAllow: ["read", "workflow.start"],
                explicitDeny: [],
              },
              sandbox: {
                mode: "non-main",
                scope: "agent",
                workspaceAccess: "ro",
                backend: "docker",
              },
              filesystem: { workspaceOnly: true },
              heartbeat: { enabled: false, intervalMs: null },
              memorySearch: { state: "disabled" },
              subagentTargets: {
                allowedAgentIds: ["workflow"],
                allowAnyConfiguredAgent: false,
                implicitSelfAllowed: true,
                requireAgentId: false,
              },
            },
            unresolved: ["runtime-tools", "sandbox-runtime", "memory-runtime", "scheduler-runtime"],
          },
          scheduledJobs: { coverage: "package-declarations", jobs: [] },
          readiness: { ready: true, requirements: [] },
        },
      },
    });
    try {
      await page.goto(`${server.baseUrl}agents`);
      const roster = page.locator(".agents-home__card");
      await roster.first().waitFor();
      const explore = page.locator("[data-claws-explore]");
      const cards = explore.locator("[data-claws-entry]");
      await cards.first().waitFor();
      expect(await page.locator("openclaw-claws-catalog-dialog").count()).toBe(0);
      expect(await explore.getByRole("searchbox", { name: "Search Claws" }).count()).toBe(1);
      expect(await cards.count()).toBe(30);
      expect(await cards.first().textContent()).toContain("Version 1.2.0");
      expect(await cards.first().textContent()).toContain("12 downloads");
      expect((await gateway.waitForRequest("claws.catalog.search")).params).toEqual({});
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      if (capture) {
        const dir = createControlUiE2eArtifactDir(`claws-${viewport.name}`);
        await page.screenshot({ path: `${dir}/agents.png`, animations: "disabled" });
      }

      const openCatalog = page.locator("[data-claws-open-catalog]");
      expect(await openCatalog.getAttribute("aria-label")).toBe("Search Claws");
      expect(await openCatalog.getAttribute("aria-haspopup")).toBe("dialog");
      await openCatalog.focus();
      await page.keyboard.press("Enter");
      const catalog = page.locator(".claws-catalog");
      const catalogSearch = catalog.getByRole("searchbox", { name: "Search Claws" });
      await catalogSearch.waitFor();
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-claws-search"));
      await catalogSearch.fill("Workflow");
      expect(
        (await gateway.waitForRequest("claws.catalog.search", { match: { query: "Workflow" } }))
          .params,
      ).toEqual({ query: "Workflow" });
      expect(await catalog.locator("[data-claws-entry]").count()).toBe(1);
      if (capture) {
        const dir = createControlUiE2eArtifactDir(`claws-catalog-${viewport.name}`);
        await page.screenshot({ path: `${dir}/catalog.png`, animations: "disabled" });
      }
      await catalog.getByRole("button", { name: "Close" }).click();
      await page.locator("openclaw-claws-catalog-dialog").waitFor({ state: "detached" });

      await cards.first().getByRole("button", { name: "Add" }).click();
      const dialog = page.locator(".claws-catalog");
      await dialog.getByText("workflow-tools").first().waitFor();
      expect(await dialog.locator(".claws-catalog__list").count()).toBe(0);
      await dialog.getByText("Configured access", { exact: true }).waitFor();
      await dialog.getByText("workflow.start", { exact: true }).waitFor();
      await dialog.getByText("workspace/SOUL.md", { exact: true }).waitFor();
      await dialog.getByText("sha256:starter-soul", { exact: true }).waitFor();
      await dialog.getByText(pluginIntegrity, { exact: true }).waitFor();
      await dialog.getByText("Install actions", { exact: true }).waitFor();
      expect(
        await dialog.locator(".claws-catalog__body").evaluate((body) => body.scrollWidth),
      ).toBeLessThanOrEqual(
        await dialog.locator(".claws-catalog__body").evaluate((body) => body.clientWidth),
      );
      expect((await gateway.waitForRequest("claws.add.plan")).params).toEqual({
        source: { packageName: "@openclaw/workflow-operator", version: "1.2.0" },
      });
      const reviewBounds = await dialog.boundingBox();
      expect(reviewBounds).not.toBeNull();
      expect(reviewBounds!.x).toBeGreaterThanOrEqual(0);
      expect(reviewBounds!.x + reviewBounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(reviewBounds!.y).toBeGreaterThanOrEqual(0);
      expect(reviewBounds!.y + reviewBounds!.height).toBeLessThanOrEqual(viewport.height);
      expect(await dialog.getByRole("button", { name: "Add Claw" }).isEnabled()).toBe(true);
      await dialog.getByRole("button", { name: "Add Claw" }).scrollIntoViewIfNeeded();
      const confirmBounds = await dialog.getByRole("button", { name: "Add Claw" }).boundingBox();
      expect(confirmBounds).not.toBeNull();
      expect(confirmBounds!.y).toBeGreaterThanOrEqual(0);
      expect(confirmBounds!.y + confirmBounds!.height).toBeLessThanOrEqual(viewport.height);
      if (capture) {
        const dir = createControlUiE2eArtifactDir(`claws-review-${viewport.name}`);
        await page.screenshot({ path: `${dir}/review.png`, animations: "disabled" });
      }
    } finally {
      await context.close();
    }
  });

  it("hides stale Add results while a new search is pending or fails", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();
    const config = { gateway: { controlUi: { experimental: { claws: true } } } };
    const gateway = await installMockGateway(page, {
      featureMethods: ["claws.catalog.search"],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          resolved: config,
          raw: JSON.stringify(config),
          hash: "claws-stale-search-config",
          path: "/tmp/openclaw-claws-stale-search.json",
          valid: true,
          issues: [],
        },
        "claws.catalog.search": { entries: [workflowOperator] },
      },
    });
    try {
      await page.goto(`${server.baseUrl}agents`);
      await page.locator("[data-claws-open-catalog]").click();
      const catalog = page.locator(".claws-catalog");
      const entries = catalog.locator("[data-claws-entry]");
      await entries.first().waitFor();

      await gateway.deferNext("claws.catalog.search", { query: "research" });
      await catalog.getByRole("searchbox", { name: "Search Claws" }).fill("research");
      await entries.first().waitFor({ state: "detached", timeout: 3_000 });
      await gateway.waitForRequest("claws.catalog.search", { match: { query: "research" } });
      expect(await entries.count()).toBe(0);

      await gateway.rejectDeferred("claws.catalog.search", {
        message: "Catalog temporarily unavailable",
      });
      await catalog.getByRole("alert").waitFor();
      expect(await entries.count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("keeps installed agents while Labs hides Explore and Add", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();
    const config = { gateway: { controlUi: { experimental: { claws: false } } } };
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "openclaw.chat",
        "claws.catalog.search",
        "claws.catalog.detail",
        "claws.add.plan",
      ],
      methodResponses: {
        "config.get": {
          config,
          sourceConfig: config,
          resolved: config,
          raw: JSON.stringify(config),
          hash: "claws-e2e-labs-off",
          path: "/tmp/openclaw-claws-e2e.json",
          valid: true,
          issues: [],
        },
        "claws.catalog.search": { entries: starterClaws },
      },
    });
    try {
      await page.goto(`${server.baseUrl}agents`);
      await page.locator(".agents-home__card").first().waitFor();
      expect(await page.locator("[data-claws-explore]").count()).toBe(0);
      expect(await page.locator("[data-claws-open-catalog]").count()).toBe(0);
      expect(await page.locator("[data-claws-search]").count()).toBe(0);
      expect(await page.locator("[data-claws-entry]").count()).toBe(0);
      expect(await gateway.getRequests("claws.catalog.search")).toHaveLength(0);
      if (capture) {
        const dir = createControlUiE2eArtifactDir("claws-labs-off");
        await page.screenshot({ path: `${dir}/agents.png`, animations: "disabled" });
      }
    } finally {
      await context.close();
    }
  });
});
