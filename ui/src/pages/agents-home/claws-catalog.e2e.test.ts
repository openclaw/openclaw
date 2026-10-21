import { writeFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
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
  ownerHandle: "openclaw",
  downloads: 12,
  updatedAtMs: 1_000,
};
const communityResearch = {
  ...workflowOperator,
  packageName: "@maker/release-scout",
  displayName: "Release Scout",
  summary: "Compares public releases with sourced migration guidance.",
  channel: "community",
  official: false,
  ownerHandle: "maker",
  downloads: 20,
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

describe.skipIf(!browserAvailable)("Claws discovery and Add", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  async function fixture(
    page: import("playwright").Page,
    entry = workflowOperator,
    detailPublisher: Partial<Pick<typeof workflowOperator, "ownerHandle" | "official">> = {},
  ) {
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
        "claws.catalog.search": { entries: [entry] },
        "claws.catalog.detail": {
          detail: {
            ...entry,
            ...detailPublisher,
            version: "1.2.0",
            agentName: "Workflow Operator",
            workspaceFiles: 5,
            skills: 1,
            plugins: 1,
            mcpServers: 0,
            scheduledJobs: 0,
            contents: {
              instructions: [
                { name: "AGENTS.md", source: "workspace/AGENTS.md", excerpt: agentsExcerpt },
                { name: "SOUL.md", source: "workspace/SOUL.md", excerpt: soulExcerpt },
                { name: "USER.md", source: "workspace/USER.md" },
                { name: "BOOTSTRAP.md", source: "BOOTSTRAP.md" },
                { name: "notes/context.md", source: "notes/context.md" },
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

  it("uses Plugins discovery controls and category shelves instead of Browse all", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const gateway = await fixture(page);
    const proofDir = capture ? createControlUiE2eArtifactDir("claws-featured-categories") : null;
    try {
      await page.goto(`${server.baseUrl}claws`);
      await page.locator("[data-claws-featured] [data-claws-entry]").first().waitFor();
      await page.locator('[data-claws-category="research"] [data-claws-entry]').first().waitFor();
      expect(await page.getByRole("heading", { name: "Featured" }).count()).toBe(1);
      expect(await page.getByRole("heading", { name: "Browse all" }).count()).toBe(0);
      expect(
        await page.locator('.plugin-catalog-section[data-catalog-section="research"]').count(),
      ).toBe(1);
      expect(
        await page.locator('.plugin-catalog-section[data-catalog-section="personal"]').count(),
      ).toBe(1);
      expect(await page.locator(".plugin-catalog-chips .plugin-catalog-chip").count()).toBe(14);
      expect(
        await page
          .locator(".plugin-catalog-chips")
          .evaluate((element) => getComputedStyle(element).flexWrap),
      ).toBe("wrap");
      const searchWidth = await page
        .locator(".plugin-catalog-search")
        .evaluate((element) => element.getBoundingClientRect().width);
      const bodyWidth = await page
        .locator(".plugin-catalog-results__body")
        .evaluate((element) => element.getBoundingClientRect().width);
      expect(Math.abs(searchWidth - bodyWidth)).toBeLessThan(2);
      expect(await gateway.getRequests("claws.catalog.search")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            params: expect.objectContaining({ featured: true, limit: 8 }),
          }),
          expect.objectContaining({
            params: expect.objectContaining({ category: "research", limit: 8 }),
          }),
        ]),
      );
      if (proofDir) {
        await page.screenshot({ path: `${proofDir}/featured.png`, animations: "disabled" });
      }

      await gateway.setMethodResponse("claws.catalog.search", {
        entries: [communityResearch, { ...workflowOperator, downloads: 1 }],
      });
      await page.getByRole("button", { name: "Research", exact: true }).click();
      await gateway.waitForRequest("claws.catalog.search", { match: { category: "research" } });
      await page.locator("[data-claws-results] [data-claws-entry]").first().waitFor();
      expect(await page.locator("[data-claws-featured]").count()).toBe(0);
      const categoryCards = page.locator("[data-claws-results] [data-claws-entry]");
      expect(await categoryCards.count()).toBe(2);
      expect(await categoryCards.first().textContent()).toContain("Release Scout");
      expect(await categoryCards.nth(1).textContent()).toContain("Workflow Operator");
      if (proofDir) {
        await categoryCards.first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${proofDir}/research.png`, animations: "disabled" });
      }
    } finally {
      await context.close();
    }
  });
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
        await page.goto(`${server.baseUrl}claws`);
        const card = page.locator("[data-claws-explore] [data-claws-entry]").first();
        await card.waitFor();
        expect(await card.getByRole("button", { name: "Add" }).count()).toBe(1);
        expect(await card.textContent()).toContain("@openclaw");
        expect(await card.textContent()).not.toContain("by @openclaw");
        expect(await card.textContent()).not.toContain("@openclaw/workflow-operator");
        expect(await page.locator("[data-claws-attention]").count()).toBe(0);
        if (capture) {
          const toolbar = page.locator(".hub-page-header.claws-catalog-header");
          const frame = await takeControlUiScreenshotFrame(
            page,
            toolbar,
            [
              page.getByRole("heading", { level: 1, name: "Claws", exact: true }),
              page.getByText("Purpose-built agents for your team.", { exact: true }),
              page.getByRole("searchbox", { name: "Search Claws", exact: true }),
            ],
            { scrollTo: toolbar, animations: "disabled" },
          );
          const dir = createControlUiE2eArtifactDir(`claws-add-${viewport.name}`);
          await writeFile(`${dir}/agents-claws.png`, frame.png);
        }
        await card.getByRole("button", { name: "Add" }).click();
        await page.waitForURL(/\/claws\/packages\/%40openclaw%2Fworkflow-operator$/u);
        const detail = page.locator(".plugin-catalog-detail");
        await detail.getByRole("heading", { name: "Skills" }).waitFor();
        const publisher = detail.locator(".plugin-catalog-detail__publisher");
        expect(await publisher.locator("strong").textContent()).toBe("OpenClaw");
        expect(await publisher.getByRole("link", { name: "@openclaw" }).getAttribute("href")).toBe(
          "https://clawhub.ai/openclaw",
        );
        expect(await publisher.getByRole("img", { name: "Official" }).count()).toBe(1);
        expect(await detail.getByRole("heading", { name: "Workspace files" }).count()).toBe(1);
        const workspace = detail.locator(".plugin-capabilities").first();
        expect(await workspace.locator("h2 > span").textContent()).toBe("5");
        expect(
          await workspace.locator(".claws-workspace-file__open strong").allTextContents(),
        ).toEqual(["SOUL.md", "AGENTS.md", "USER.md", "BOOTSTRAP.md", "notes/context.md"]);
        expect(await workspace.locator(".claws-workspace-file__info").count()).toBe(5);
        expect(await workspace.getByRole("button", { name: "View all" }).count()).toBe(0);
        const help = workspace.getByRole("button", { name: "About SOUL.md" });
        await workspace.getByRole("button", { name: "SOUL.md", exact: true }).focus();
        await page.keyboard.press("Tab");
        expect(await help.evaluate((button) => button === document.activeElement)).toBe(true);
        const tooltip = workspace.locator("openclaw-tooltip").first();
        await tooltip.locator("[role=tooltip]").waitFor({ state: "visible" });
        expect(await tooltip.getByRole("tooltip").textContent()).toContain(
          "persona, tone, and boundaries",
        );
        expect(await gateway.getRequests("claws.catalog.preview")).toHaveLength(0);
        if (capture) {
          const dir = createControlUiE2eArtifactDir(`claws-add-${viewport.name}`);
          await page.screenshot({ path: `${dir}/file-purpose.png`, animations: "disabled" });
        }
        await page.keyboard.press("Escape");
        await tooltip.locator("[role=tooltip]").waitFor({ state: "hidden" });
        await help.click();
        await tooltip.locator("[role=tooltip]").waitFor({ state: "visible" });
        expect(await gateway.getRequests("claws.catalog.preview")).toHaveLength(0);
        await page.keyboard.press("Escape");
        await detail.getByRole("heading", { name: "Workspace files" }).click();
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
        await gateway.setMethodResponse("claws.catalog.preview", {
          preview: { kind: "instruction", name: "SOUL.md", content: "# Soul preview" },
        });
        await workspace.getByRole("button", { name: "SOUL.md", exact: true }).click();
        const preview = page.locator("openclaw-file-preview-modal");
        await preview.locator(".item[data-path='USER.md']").waitFor();
        expect(await preview.locator(".item").count()).toBe(5);
        await preview.getByRole("heading", { name: "Soul preview", exact: true }).waitFor();
        if (capture) {
          const dir = createControlUiE2eArtifactDir(`claws-add-${viewport.name}`);
          await page.screenshot({ path: `${dir}/all-files.png`, animations: "disabled" });
        }
        for (const name of ["USER.md", "BOOTSTRAP.md", "notes/context.md"]) {
          await gateway.setMethodResponse("claws.catalog.preview", {
            preview: { kind: "instruction", name, content: `# Preview ${name}` },
          });
          await preview.locator(`.item[data-path="${name}"]`).click();
          await preview.getByRole("heading", { name: `Preview ${name}`, exact: true }).waitFor();
          expect((await gateway.getRequests("claws.catalog.preview")).at(-1)?.params).toMatchObject(
            { name },
          );
        }
      } finally {
        await context.close();
      }
    },
  );

  it("uses the accepted detail publisher when the catalog identity is stale", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await fixture(
      page,
      { ...workflowOperator, packageName: "workflow-operator" },
      { ownerHandle: "maker", official: false },
    );
    try {
      await page.goto(`${server.baseUrl}claws`);
      const card = page.locator("[data-claws-explore] [data-claws-entry]").first();
      await card.waitFor();
      expect(await card.textContent()).toContain("@openclaw");
      await card.getByRole("button", { name: "Add" }).click();
      const detail = page.locator(".plugin-catalog-detail");
      await detail.getByRole("heading", { name: "Skills" }).waitFor();
      expect(await detail.locator("[data-claws-confirm] button").isEnabled()).toBe(true);
      if (capture) {
        const dir = createControlUiE2eArtifactDir("claws-detail-publisher-refresh");
        await page.screenshot({ path: `${dir}/detail.png`, animations: "disabled" });
      }
      const publisher = detail.locator(".plugin-catalog-detail__publisher");
      expect(await publisher.getByRole("img", { name: "Official" }).count()).toBe(0);
      expect(await publisher.locator("strong").textContent()).toBe("maker");
      expect(await publisher.getByRole("link", { name: "@maker" }).getAttribute("href")).toBe(
        "https://clawhub.ai/maker",
      );
    } finally {
      await context.close();
    }
  });

  it("adds a personal publisher Claw and sends the first chat message despite pending setup", async () => {
    const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
    const page = await context.newPage();
    const community = {
      ...workflowOperator,
      packageName: "@maker/workflow-operator",
      ownerHandle: "maker",
      channel: "community",
      official: false,
    };
    const gateway = await fixture(page, community);
    try {
      await page.goto(`${server.baseUrl}claws`);
      await page
        .locator("[data-claws-explore] [data-claws-entry]")
        .first()
        .getByRole("button", { name: "Add" })
        .click();
      await page
        .locator(".plugin-catalog-detail")
        .getByRole("heading", { name: "Skills" })
        .waitFor();
      const publisher = page.locator(".plugin-catalog-detail__publisher");
      expect(await publisher.getByRole("link", { name: "@maker" }).count()).toBe(1);
      expect(await publisher.getByRole("img", { name: "Official" }).count()).toBe(0);
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
        source: { packageName: community.packageName, version: "1.2.0" },
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
