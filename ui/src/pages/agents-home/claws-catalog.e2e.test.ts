import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const browserAvailable = canRunPlaywrightChromium(executablePath);
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
};
const researchClaw = {
  ...workflowOperator,
  packageName: "@maker/release-scout",
  displayName: "Release Scout",
};
const soulExcerpt = "Keep the owner informed about approved workflows. ".repeat(24);
const config = { gateway: { controlUi: { experimental: { claws: true } } } };
const agentsList = makeBootRoster({ agents: [{ id: "main", name: "Main" }] });

let browser: Browser;
let server: ControlUiE2eServer;

describe.skipIf(!browserAvailable)("Claws discovery and Add", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  async function fixture(
    viewport = { width: 1440, height: 900 },
    entry = workflowOperator,
    detailPublisher: Partial<Pick<typeof workflowOperator, "ownerHandle" | "official">> = {},
  ) {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: viewport.width, height: viewport.height },
    });
    onTestFinished(() => context.close());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
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
        "agents.list": agentsList,
        "claws.catalog.search": { entries: [entry] },
        "claws.catalog.detail": {
          detail: {
            ...entry,
            ...detailPublisher,
            version: "1.2.0",
            agentName: "Workflow Operator",
            contents: {
              instructions: [
                { name: "SOUL.md", source: "workspace/SOUL.md", excerpt: soulExcerpt },
                { name: "AGENTS.md", source: "workspace/AGENTS.md" },
              ],
              skills: [{ name: "Trip research", excerpt: "Research trips." }],
              integrations: [
                { name: "@openclaw/workflow-tools", kind: "plugin", version: "1.2.0" },
              ],
              automations: [],
            },
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
    await page.goto(`${server.baseUrl}claws`);
    return { page, gateway };
  }

  async function openDetail(page: Page) {
    const card = page.locator("[data-claws-explore] [data-claws-entry]").first();
    await card.getByRole("button", { name: "Add" }).click();
    const detail = page.locator(".plugin-catalog-detail");
    await detail.getByRole("heading", { name: "Workspace files" }).waitFor();
    return detail;
  }

  async function expectPublisher(detail: Locator, handle: string, official: boolean) {
    const publisher = detail.locator(".plugin-catalog-detail__publisher");
    expect(await publisher.locator("strong").textContent()).toBe(official ? "OpenClaw" : handle);
    expect(await publisher.getByRole("link", { name: `@${handle}` }).getAttribute("href")).toBe(
      `https://clawhub.ai/${handle}`,
    );
    expect(await publisher.getByRole("img", { name: "Official" }).count()).toBe(Number(official));
  }

  async function expectClamped(description: Locator) {
    const layout = await description.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        clamp: style.webkitLineClamp,
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
        scrollHeight: element.scrollHeight,
      };
    });
    expect(layout.clamp).toBe("2");
    expect(layout.height).toBeLessThanOrEqual(layout.lineHeight * 2 + 1);
    expect(layout.scrollHeight).toBeGreaterThan(layout.height);
  }

  it("lays out featured cards and switches category shelves to filtered results", async () => {
    const { page, gateway } = await fixture();
    await page.locator("[data-claws-featured] [data-claws-entry]").first().waitFor();
    await page.locator('[data-claws-category="research"] [data-claws-entry]').first().waitFor();
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
    // Four-column cards are too narrow to fit the name between the artwork and Add.
    const titleRow = await page
      .locator("[data-claws-featured] [data-claws-entry] .agents-home__claw-head")
      .first()
      .evaluate((head) => ({
        head: head.getBoundingClientRect().width,
        name: head.querySelector("h3")?.getBoundingClientRect().width ?? 0,
      }));
    expect(Math.abs(titleRow.head - titleRow.name)).toBeLessThan(1);
    await gateway.waitForRequest("claws.catalog.search", { match: { featured: true, limit: 8 } });

    await gateway.setMethodResponse("claws.catalog.search", {
      entries: [researchClaw, workflowOperator],
    });
    await page.getByRole("button", { name: "Research", exact: true }).click();
    await gateway.waitForRequest("claws.catalog.search", { match: { category: "research" } });
    await page.locator("[data-claws-results] [data-claws-entry]").first().waitFor();
    expect(await page.locator("[data-claws-featured]").count()).toBe(0);
    const categoryCards = page.locator("[data-claws-results] [data-claws-entry]");
    expect(await categoryCards.count()).toBe(2);
    expect(await categoryCards.first().textContent()).toContain("Release Scout");
    expect(await categoryCards.nth(1).textContent()).toContain("Workflow Operator");
  });
  it.each(viewports)(
    "shows the Claw contents at $name width without empty sections",
    async (viewport) => {
      const { page, gateway } = await fixture(viewport);
      const card = page.locator("[data-claws-explore] [data-claws-entry]").first();
      await card.waitFor();
      expect(await card.textContent()).toContain("@openclaw");
      const detail = await openDetail(page);
      await page.waitForURL(/\/claws\/packages\/%40openclaw%2Fworkflow-operator$/u);
      await expectPublisher(detail, "openclaw", true);
      const workspace = detail.locator(".plugin-capabilities").first();
      const help = workspace.getByRole("button", { name: "About SOUL.md" });
      await workspace.getByRole("button", { name: "SOUL.md", exact: true }).focus();
      await page.keyboard.press("Tab");
      expect(await help.evaluate((button) => button === document.activeElement)).toBe(true);
      const tooltip = workspace.locator("openclaw-tooltip").first();
      await tooltip.locator("[role=tooltip]").waitFor({ state: "visible" });
      expect(await gateway.getRequests("claws.catalog.preview")).toHaveLength(0);
      await page.keyboard.press("Escape");
      await tooltip.locator("[role=tooltip]").waitFor({ state: "hidden" });
      await help.click();
      await tooltip.locator("[role=tooltip]").waitFor({ state: "visible" });
      expect(await gateway.getRequests("claws.catalog.preview")).toHaveLength(0);
      await page.keyboard.press("Escape");
      await detail.getByRole("heading", { name: "Workspace files" }).click();
      const fileDescriptions = workspace.locator(".plugin-capability__copy > span");
      expect(await fileDescriptions.allTextContents()).toEqual([soulExcerpt]);
      await expectClamped(fileDescriptions.first());
      expect(await detail.getByText("Research trips.", { exact: true }).count()).toBe(1);
      expect(await detail.getByRole("heading", { name: "Integrations" }).count()).toBe(1);
      expect(await detail.getByRole("heading", { name: "Automations" }).count()).toBe(0);
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
    },
  );

  it("uses the accepted publisher to add a personal Claw and start chat despite pending setup", async () => {
    const community = {
      ...workflowOperator,
      packageName: "@maker/workflow-operator",
      channel: "community",
    };
    const { page, gateway } = await fixture(undefined, community, {
      ownerHandle: "maker",
      official: false,
    });
    const card = page.locator("[data-claws-explore] [data-claws-entry]").first();
    await card.waitFor();
    expect(await card.textContent()).toContain("@openclaw");
    const detail = await openDetail(page);
    expect(await detail.locator("[data-claws-confirm] button").isEnabled()).toBe(true);
    await expectPublisher(detail, "maker", false);
    await gateway.setMethodResponse("agents.list", {
      ...agentsList,
      agents: [...agentsList.agents, { id: "workflow-operator", name: "Workflow Operator" }],
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
  });
});
