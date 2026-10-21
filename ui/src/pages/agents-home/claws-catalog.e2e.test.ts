import { writeFile } from "node:fs/promises";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
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
  channel: "community",
  official: false,
  ownerHandle: "maker",
  downloads: 20,
};
const soulExcerpt = "Purpose. Run approved workflows and keep the owner informed. ".repeat(20);
const agentsExcerpt = "Instructions. Review each step before execution and record the result.";
const skillExcerpt =
  "Research a trip, check reliable sources, and prepare a useful itinerary. ".repeat(20);
const config = { gateway: { controlUi: { experimental: { claws: true } } } };

let browser: Browser;
let server: ControlUiE2eServer;

async function fixture(
  page: Page,
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
      "config.get": { config, sourceConfig: config, resolved: config, valid: true },
      "agents.list": agentList({ id: "main", name: "Main" }),
      "claws.catalog.search": { entries: [entry] },
      "claws.catalog.detail": {
        detail: {
          ...entry,
          ...detailPublisher,
          version: "1.2.0",
          agentName: "Workflow Operator",
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
            integrations: [{ name: "@openclaw/workflow-tools", kind: "plugin", version: "1.2.0" }],
            automations: [],
          },
        },
      },
      "plugins.list": {
        plugins: [
          {
            id: "workflow-tools",
            packageName: "@openclaw/workflow-tools",
            clawhubPackage: "@openclaw/workflow-tools",
            installed: true,
          },
        ],
      },
      "claws.add.apply": {
        agentId: "workflow-operator",
        status: "complete",
        readiness: { ready: false, requirements: [{ kind: "oauth", owner: "workflows" }] },
      },
    },
  });
}

async function createPage(viewport?: { width: number; height: number }) {
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
  });
  onTestFinished(() => context.close());
  return context.newPage();
}

async function openHome(
  viewport: Parameters<typeof createPage>[0],
  entry = workflowOperator,
  publisher: Partial<Pick<typeof workflowOperator, "ownerHandle" | "official">> = {},
) {
  const page = await createPage(viewport);
  const gateway = await fixture(page, entry, publisher);
  await page.goto(`${server.baseUrl}agents`);
  return { page, gateway, card: page.locator("[data-claws-explore] [data-claws-entry]").first() };
}

async function screenshot(
  page: Page,
  directory: string,
  name: string,
  target?: Locator,
  highlights: Locator[] = [],
) {
  if (!capture) {
    return;
  }
  const path = `${createControlUiE2eArtifactDir(directory)}/${name}.png`;
  if (target) {
    const frame = await takeControlUiScreenshotFrame(page, target, highlights, {
      animations: "disabled",
      scrollTo: target,
    });
    await writeFile(path, frame.png);
  } else {
    await page.screenshot({ path, animations: "disabled" });
  }
}

function agentList(...agents: AgentsListResult["agents"]) {
  return { defaultId: "main", mainKey: "main", scope: "per-sender", agents };
}

async function expectPublisher(detail: Locator, name: string, handle: string, official: number) {
  const publisher = detail.locator(".plugin-catalog-detail__publisher");
  expect({
    name: await publisher.locator("strong").textContent(),
    href: await publisher.getByRole("link", { name: `@${handle}` }).getAttribute("href"),
    official: await publisher.getByRole("img", { name: "Official" }).count(),
  }).toEqual({ name, href: `https://clawhub.ai/${handle}`, official });
}

async function expectClamped(locator: Locator) {
  const layout = await locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      lineClamp: style.webkitLineClamp,
      height: element.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      scrollHeight: element.scrollHeight,
    };
  });
  expect(layout.lineClamp).toBe("2");
  expect(layout.height).toBeLessThanOrEqual(layout.lineHeight * 2 + 1);
  expect(layout.scrollHeight).toBeGreaterThan(layout.height);
}

describe.skipIf(!browserAvailable)("Claws Add in Agents", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("loads Featured then category results without an Official filter", async () => {
    const { page, gateway } = await openHome({ width: 1440, height: 900 });
    await page.locator("[data-claws-featured] [data-claws-entry]").first().waitFor();
    expect(await page.getByRole("heading", { name: "Featured" }).count()).toBe(1);
    expect(await gateway.getRequests("claws.catalog.search")).toEqual(
      expect.arrayContaining([expect.objectContaining({ params: { featured: true } })]),
    );
    await screenshot(page, "claws-featured-categories", "featured");

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
    if (capture) {
      await categoryCards.first().scrollIntoViewIfNeeded();
    }
    await screenshot(page, "claws-featured-categories", "research");
  });

  it.each(viewports)("aligns agent cards with Claws at $name width", async (viewport) => {
    const page = await createPage(viewport);
    const name = "Research briefing for the international product and engineering team";
    const message =
      "The research briefing is ready, with sources and next steps for the team. ".repeat(8);
    await installMockGateway(page, {
      featureMethods: ["openclaw.chat", "claws.catalog.search"],
      methodResponses: {
        "config.get": { config, sourceConfig: config, resolved: config, valid: true },
        "agents.list": agentList(
          { id: "main", name, model: { primary: "example/model-small" } },
          { id: "empty", name: "New teammate" },
        ),
        "sessions.list": {
          ts: 6_000,
          path: "",
          count: 1,
          sessions: [
            {
              key: "agent:main:main",
              agentId: "main",
              kind: "direct",
              isMain: true,
              updatedAt: 5_000,
              lastMessagePreview: message,
            },
          ],
          defaults: { model: null, modelProvider: null, contextTokens: null },
          hasMore: false,
        },
        "claws.catalog.search": { entries: [workflowOperator] },
      },
    });
    await page.goto(`${server.baseUrl}agents`);
    const agent = page.locator('.agents-home__card[data-agent-id="main"]');
    const empty = page.locator('.agents-home__card[data-agent-id="empty"]');
    const claw = page.locator("[data-claws-entry]").first();
    await expect.poll(() => agent.locator(".agents-home__preview").textContent()).toBe(message);
    await claw.waitFor();
    expect(await agent.getByRole("heading").textContent()).toBe(name);

    const styles = (locator: Locator) =>
      locator.evaluate((element) => {
        const css = getComputedStyle(element);
        return [
          css.padding,
          css.gap,
          css.fontSize,
          css.lineHeight,
          css.color,
          css.backgroundColor,
          css.borderRadius,
        ];
      });
    expect(await styles(agent)).toEqual(await styles(claw));
    expect(await styles(agent.locator(".agents-home__open"))).toEqual(
      await styles(claw.getByRole("button", { name: "Add" })),
    );
    expect(await styles(agent.locator(".agents-home__preview"))).toEqual(
      await styles(claw.locator(".agents-home__claw-summary")),
    );
    const layout = await agent.evaluate((element) => {
      const head = element.querySelector(".agents-home__identity")!.getBoundingClientRect();
      const action = element.querySelector(".agents-home__open")!.getBoundingClientRect();
      return {
        head: head.toJSON(),
        action: action.toJSON(),
        body: element.querySelector(".agents-home__preview")!.getBoundingClientRect().toJSON(),
      };
    });
    expect(Math.abs(layout.action.y - layout.head.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.action.right - layout.head.right)).toBeLessThanOrEqual(1);
    expect(layout.body.y).toBeGreaterThanOrEqual(layout.head.bottom);
    await expectClamped(agent.locator(".agents-home__preview"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
    await screenshot(page, `agents-cards-${viewport.name}`, "cards", agent, [
      agent.getByRole("heading"),
      agent.locator(".agents-home__preview"),
    ]);
    await agent.focus();
    await page.keyboard.press("Tab");
    expect(await empty.evaluate((element) => document.activeElement === element)).toBe(true);
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/chat\/empty$/u);
    await page.goBack();
    await agent.locator(".agents-home__open").click();
    await page.waitForURL(/\/chat\/main$/u);
  });

  it.each(viewports)("renders complete Claw contents at $name width", async (viewport) => {
    const page = await createPage({ width: viewport.width, height: viewport.height });
    const gateway = await fixture(page);
    await page.goto(`${server.baseUrl}agents`);
    const card = page.locator("[data-claws-explore] [data-claws-entry]").first();
    await card.waitFor();
    expect(await card.getByRole("button", { name: "Add" }).count()).toBe(1);
    expect(await card.textContent()).toContain("@openclaw");
    expect(await card.textContent()).not.toMatch(/by @openclaw|@openclaw\/workflow-operator/u);
    expect(await page.locator("[data-claws-attention]").count()).toBe(0);
    const catalog = page.locator("[data-claws-explore]");
    await screenshot(
      page,
      `claws-add-${viewport.name}`,
      "agents-claws",
      catalog.locator(".agents-home__explore-toolbar"),
      [
        catalog.getByRole("heading", { level: 2, name: "Claws", exact: true }),
        catalog.getByText("Purpose-built agents for your team.", { exact: true }),
        catalog.getByRole("searchbox", { name: "Search Claws", exact: true }),
      ],
    );
    await card.locator(".agents-home__claw-card-link").click();
    await page.waitForURL(/\/agents\/claws\/packages\/%40openclaw%2Fworkflow-operator$/u);
    const detail = page.locator(".plugin-catalog-detail");
    await detail.getByRole("heading", { name: "Skills" }).waitFor();
    expect((await gateway.waitForRequest("claws.catalog.detail")).params).toEqual({
      packageName: workflowOperator.packageName,
      version: workflowOperator.latestVersion,
    });
    await expectPublisher(detail, "OpenClaw", "openclaw", 1);
    expect(await detail.getByRole("heading", { name: "Workspace files" }).count()).toBe(1);
    const sections = detail.locator(".plugin-capabilities");
    const workspace = sections.first();
    const skills = sections.nth(1);
    expect(await workspace.locator("h2 > span").textContent()).toBe("5");
    expect(await workspace.locator(".claws-workspace-file__open strong").allTextContents()).toEqual(
      ["SOUL.md", "AGENTS.md", "USER.md", "BOOTSTRAP.md", "notes/context.md"],
    );
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
    await screenshot(page, `claws-add-${viewport.name}`, "file-purpose");
    await page.keyboard.press("Escape");
    await tooltip.locator("[role=tooltip]").waitFor({ state: "hidden" });
    await help.click();
    await tooltip.locator("[role=tooltip]").waitFor({ state: "visible" });
    expect(await gateway.getRequests("claws.catalog.preview")).toHaveLength(0);
    await page.keyboard.press("Escape");
    await detail.getByRole("heading", { name: "Workspace files" }).click();
    const fileDescriptions = workspace.locator(".plugin-capability__copy > span");
    expect(await fileDescriptions.allTextContents()).toEqual([soulExcerpt, agentsExcerpt]);
    await expectClamped(fileDescriptions.first());
    expect(await detail.getByText("Added to the workspace").count()).toBe(0);
    const skillDescription = skills.locator(".plugin-capability__copy > span");
    expect(await skillDescription.textContent()).toBe(skillExcerpt);
    await expectClamped(skillDescription);
    expect(await skills.getByText("Version 1.2.0").count()).toBe(0);
    expect(await detail.getByRole("heading", { name: "Integrations" }).count()).toBe(1);
    expect(await detail.getByRole("heading", { name: "Automations" }).count()).toBe(0);
    expect(await detail.locator("[data-claws-confirm] button").count()).toBe(1);
    await detail.getByText("Installed", { exact: true }).waitFor();
    expect(await detail.locator(".plugin-connection-status svg").count()).toBe(1);
    const descriptionBounds = await detail.locator(".plugin-catalog-detail__summary").boundingBox();
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
    await screenshot(page, `claws-add-${viewport.name}`, "detail");
    await gateway.setMethodResponse("claws.catalog.preview", {
      preview: { kind: "instruction", name: "SOUL.md", content: "# Soul preview" },
    });
    await workspace.getByRole("button", { name: "SOUL.md", exact: true }).click();
    const preview = page.locator("openclaw-file-preview-modal");
    await preview.locator(".item[data-path='USER.md']").waitFor();
    expect(
      await preview
        .locator(".item")
        .evaluateAll((items) => items.map((item) => item.getAttribute("data-path"))),
    ).toEqual(["AGENTS.md", "SOUL.md", "USER.md", "BOOTSTRAP.md", "notes/context.md"]);
    await preview.getByRole("heading", { name: "Soul preview", exact: true }).waitFor();
    await screenshot(page, `claws-add-${viewport.name}`, "all-files");
    for (const name of ["AGENTS.md", "SOUL.md", "USER.md", "BOOTSTRAP.md", "notes/context.md"]) {
      await gateway.setMethodResponse("claws.catalog.preview", {
        preview: { kind: "instruction", name, content: `# Preview ${name}` },
      });
      await preview.locator(`.item[data-path="${name}"]`).click();
      await preview.getByRole("heading", { name: `Preview ${name}`, exact: true }).waitFor();
      expect((await gateway.getRequests("claws.catalog.preview")).at(-1)?.params).toMatchObject({
        name,
      });
    }
  });

  it.each([true, false])("adds a personal Claw with stale catalog identity=%s", async (stale) => {
    const proofDir = stale ? "claws-detail-publisher-refresh" : "claws-add-chat";
    const entry = {
      ...workflowOperator,
      packageName: stale ? "workflow-operator" : "@maker/workflow-operator",
      ownerHandle: stale ? "openclaw" : "maker",
      channel: stale ? "official" : "community",
      official: stale,
    };
    const { page, gateway, card } = await openHome(
      stale ? { width: 1440, height: 900 } : undefined,
      entry,
      { ownerHandle: "maker", official: false },
    );
    await card.waitFor();
    expect(await card.textContent()).toContain(`@${entry.ownerHandle}`);
    await card.getByRole("button", { name: "Add" }).click();
    const detail = page.locator(".plugin-catalog-detail");
    await detail.getByRole("heading", { name: "Skills" }).waitFor();
    expect(await detail.locator("[data-claws-confirm] button").isEnabled()).toBe(true);
    await expectPublisher(detail, "maker", "maker", 0);
    await screenshot(page, proofDir, "detail");
    await gateway.setMethodResponse(
      "agents.list",
      agentList(
        { id: "main", name: "Main" },
        { id: "workflow-operator", name: "Workflow Operator" },
      ),
    );
    await detail.locator("[data-claws-confirm] button").click();
    await page.waitForURL(/\/chat\/workflow-operator$/u);
    expect((await gateway.waitForRequest("chat.send")).params).toMatchObject({
      sessionKey: "agent:workflow-operator:main",
      message: "Workflow Operator, what can you do?",
    });
    expect((await gateway.waitForRequest("claws.add.apply")).params).toEqual({
      source: { packageName: entry.packageName, version: "1.2.0" },
    });
    expect(await gateway.getRequests("claws.add.plan")).toHaveLength(0);
    expect(await gateway.getRequests("claws.status")).toHaveLength(0);
    await screenshot(page, proofDir, "chat");
  });
});
