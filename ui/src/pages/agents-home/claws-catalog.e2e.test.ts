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
const soulExcerpt =
  "Purpose. Turn approved workflows into clear outcomes while keeping the owner informed. ".repeat(
    12,
  );
const agentsExcerpt = "Instructions. Review each step before execution and record the result.";
const skillExcerpt =
  "Use this skill to research a trip, check reliable sources, and prepare a useful itinerary. ".repeat(
    12,
  );
const config = { gateway: { controlUi: { experimental: { claws: true } } } };

let browser: Browser;
let server: ControlUiE2eServer;

describe.skipIf(!browserAvailable)("Claws Add in Agents", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  async function fixture(page: import("playwright").Page) {
    return await installMockGateway(page, {
      featureMethods: [
        "openclaw.chat",
        "claws.catalog.search",
        "claws.catalog.detail",
        "claws.catalog.preview",
        "claws.add.apply",
        "plugins.list",
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
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "main", name: "Main" }],
        },
        "claws.catalog.search": { entries: [workflowOperator] },
        "claws.catalog.detail": {
          detail: {
            ...workflowOperator,
            version: "1.2.0",
            agentName: "Workflow Operator",
            workspaceFiles: 2,
            skills: 1,
            plugins: 1,
            mcpServers: 0,
            scheduledJobs: 0,
            contents: {
              instructions: [
                { name: "AGENTS.md", source: "workspace/AGENTS.md", excerpt: agentsExcerpt },
                { name: "SOUL.md", source: "workspace/SOUL.md", excerpt: soulExcerpt },
              ],
              skills: [
                { name: "@openclaw/travel-research", version: "1.2.0", excerpt: skillExcerpt },
              ],
              integrations: [
                { name: "@openclaw/workflow-tools", kind: "plugin", version: "1.2.0" },
              ],
              automations: [],
            },
          },
        },
        "claws.catalog.preview": {
          preview: {
            kind: "instruction",
            name: "AGENTS.md",
            content: "# Previewed instructions",
          },
        },
        "plugins.list": {
          plugins: [
            {
              id: "workflow-tools",
              name: "Workflow Tools",
              packageName: "@openclaw/workflow-tools",
              clawhubPackage: "@openclaw/workflow-tools",
              installed: true,
              enabled: true,
              state: "enabled",
            },
          ],
          diagnostics: [],
          mutationAllowed: true,
        },
        "claws.add.apply": {
          agentId: "workflow-operator",
          status: "complete",
          readiness: { ready: false, requirements: [{ kind: "oauth", owner: "workflows" }] },
        },
      },
    });
  }

  it.each(viewports)(
    "shows the Claw contents at $name width without empty sections",
    async (viewport) => {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: viewport.width, height: viewport.height },
      });
      const page = await context.newPage();
      const gateway = await fixture(page);
      try {
        await page.goto(`${server.baseUrl}agents`);
        const card = page.locator("[data-claws-explore] [data-claws-entry]").first();
        await card.waitFor();
        expect(await card.getByRole("button", { name: "Add" }).count()).toBe(1);
        expect(await card.textContent()).toContain("@openclaw");
        expect(await card.textContent()).not.toContain("by @openclaw");
        expect(await card.textContent()).not.toContain("@openclaw/workflow-operator");
        expect(await page.locator("[data-claws-attention]").count()).toBe(0);
        await card.getByRole("button", { name: "Add" }).click();
        await page.waitForURL(/\/agents\/claws\/workflow-operator$/u);
        const detail = page.locator(".plugin-catalog-detail");
        await detail.getByRole("heading", { name: "Skills" }).waitFor();
        const publisher = detail.locator(".plugin-catalog-detail__publisher");
        expect(await publisher.locator("strong").textContent()).toBe("OpenClaw");
        expect(await publisher.getByRole("link", { name: "@openclaw" }).getAttribute("href")).toBe(
          "https://clawhub.ai/openclaw",
        );
        expect(await publisher.getByRole("img", { name: "Official" }).count()).toBe(1);
        expect(await detail.getByRole("heading", { name: "Workspace files" }).count()).toBe(1);
        const fileDescriptions = detail
          .locator(".plugin-capabilities")
          .first()
          .locator(".plugin-capability__copy > span");
        expect(await fileDescriptions.allTextContents()).toEqual([soulExcerpt, agentsExcerpt]);
        const fileLayout = await fileDescriptions.first().evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            lineClamp: style.webkitLineClamp,
            height: element.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(style.lineHeight),
            scrollHeight: element.scrollHeight,
          };
        });
        expect(fileLayout.lineClamp).toBe("2");
        expect(fileLayout.height).toBeLessThanOrEqual(fileLayout.lineHeight * 2 + 1);
        expect(fileLayout.scrollHeight).toBeGreaterThan(fileLayout.height);
        expect(await detail.getByText("Added to the workspace").count()).toBe(0);
        const skillDescription = detail
          .locator(".plugin-capabilities")
          .nth(1)
          .locator(".plugin-capability__copy > span");
        expect(await skillDescription.textContent()).toBe(skillExcerpt);
        const skillLayout = await skillDescription.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            lineClamp: style.webkitLineClamp,
            height: element.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(style.lineHeight),
            scrollHeight: element.scrollHeight,
          };
        });
        expect(skillLayout.lineClamp).toBe("2");
        expect(skillLayout.height).toBeLessThanOrEqual(skillLayout.lineHeight * 2 + 1);
        expect(skillLayout.scrollHeight).toBeGreaterThan(skillLayout.height);
        expect(
          await detail.locator(".plugin-capabilities").nth(1).getByText("Version 1.2.0").count(),
        ).toBe(0);
        expect(await detail.getByRole("heading", { name: "Integrations" }).count()).toBe(1);
        expect(await detail.getByRole("heading", { name: "Automations" }).count()).toBe(0);
        expect(await detail.locator("[data-claws-confirm] button").count()).toBe(1);
        await detail.getByText("Installed", { exact: true }).waitFor();
        expect(await detail.locator(".plugin-connection-status svg").count()).toBe(1);
        const descriptionBounds = await detail
          .locator(".plugin-catalog-detail__summary")
          .boundingBox();
        const actionBounds = await detail
          .locator("openclaw-plugin-install-action button")
          .boundingBox();
        expect(descriptionBounds).not.toBeNull();
        expect(actionBounds).not.toBeNull();
        expect(actionBounds!.y).toBeGreaterThanOrEqual(
          descriptionBounds!.y + descriptionBounds!.height,
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
          viewport.width,
        );
        expect(await gateway.getRequests("claws.add.plan")).toHaveLength(0);
        expect(await gateway.getRequests("claws.status")).toHaveLength(0);
        if (capture) {
          const dir = createControlUiE2eArtifactDir(`claws-add-${viewport.name}`);
          await page.screenshot({ path: `${dir}/detail.png`, animations: "disabled" });
        }
      } finally {
        await context.close();
      }
    },
  );

  it("adds an agent and sends the first chat message despite pending setup", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const gateway = await fixture(page);
    try {
      await page.goto(`${server.baseUrl}agents`);
      await page
        .locator("[data-claws-explore] [data-claws-entry]")
        .first()
        .getByRole("button", { name: "Add" })
        .click();
      await page
        .locator(".plugin-catalog-detail")
        .getByRole("heading", { name: "Skills" })
        .waitFor();
      await gateway.setMethodResponse("agents.list", {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Main" },
          { id: "workflow-operator", name: "Workflow Operator" },
        ],
      });
      await page.locator("[data-claws-confirm] button").click();
      await page.waitForURL(/\/chat\/workflow-operator$/u);
      const send = await gateway.waitForRequest("chat.send");
      expect(send.params).toMatchObject({
        sessionKey: "agent:workflow-operator:main",
        message: "Workflow Operator, what can you do?",
      });
      expect((await gateway.waitForRequest("claws.add.apply")).params).toMatchObject({
        source: { packageName: workflowOperator.packageName, version: "1.2.0" },
      });
      expect(await gateway.getRequests("claws.add.plan")).toHaveLength(0);
      expect(await gateway.getRequests("claws.status")).toHaveLength(0);
      if (capture) {
        const dir = createControlUiE2eArtifactDir("claws-add-chat");
        await page.screenshot({ path: `${dir}/chat.png`, animations: "disabled" });
      }
    } finally {
      await context.close();
    }
  });
});
