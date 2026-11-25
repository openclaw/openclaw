import { writeFile } from "node:fs/promises";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClawHubTemplateCatalogEntry } from "../../../../src/templates/clawhub-source.ts";
import { pathForPluginCatalogEntry } from "../../app-route-paths.ts";
import { LINK_READER_HOVERCARD_OPEN_DELAY_MS } from "../../components/link-reader-target.ts";
import { inspection } from "../../e2e/plugins-settings-admin.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";
import {
  agentsList,
  auditUrl,
  createTemplateCatalogFixture,
  publishedAtMs,
  skillExcerpt,
  soulExcerpt,
  weeklyAutomations,
  workflowOperator,
} from "./templates-catalog-gateway.test-support.ts";

const proofDir = createControlUiE2eArtifactDir("templates-catalog");
const capture = async (page: Page, name: string, content: Locator, scrollTo?: Locator) => {
  const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [content], {
    animations: "disabled",
    elements: name === "after-catalog" ? [content] : [],
    scrollTo,
  });
  await writeFile(`${proofDir}/${name}.png`, frame.png);
  await writeFile(
    `${proofDir}/${name}.json`,
    JSON.stringify({
      viewport: page.viewportSize(),
      scale: await page.evaluate(() => devicePixelRatio),
      elements: frame.elements.map(({ bounds }) => ({ bounds })),
    }),
  );
};

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const browserAvailable = canRunPlaywrightChromium(executablePath);
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const summaryFreeTemplate: ClawHubTemplateCatalogEntry = { ...workflowOperator };
delete summaryFreeTemplate.summary;
const researchTemplate = {
  ...workflowOperator,
  packageName: "@maker/release-scout",
  displayName: "Release Scout",
};

let browser: Browser;
let server: ControlUiE2eServer;

describe.skipIf(!browserAvailable)("Templates discovery and Add", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  const fixture = createTemplateCatalogFixture(() => ({ browser, baseUrl: server.baseUrl }));

  it.each([
    { name: "desktop", width: 1200, height: 697 },
    { name: "tall-desktop", width: 1440, height: 1200 },
    { name: "mobile", width: 390, height: 844 },
    { name: "tall-mobile", width: 390, height: 1200 },
    { name: "summary-free-mobile", width: 390, height: 844, entry: summaryFreeTemplate },
  ])("loads the catalog into its placeholders at $name size", async (viewport) => {
    const { page, gateway } = await fixture(viewport, viewport.entry, undefined, true);
    const loading = page.getByRole("status", { name: "Loading templates…" });
    await loading.waitFor();
    await capture(page, `loading-${viewport.name}`, loading);
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height].map((value) => Math.round(value * 2) / 2);
    };
    const placeholders = await loading.evaluate((status) => ({
      bottom: status.getBoundingClientRect().bottom,
      hidden: Array.from(status.children).every(
        (section) => section.getAttribute("aria-hidden") === "true",
      ),
    }));
    // Placeholders cover the visible catalog at every size without measuring it.
    expect(placeholders.bottom).toBeGreaterThanOrEqual(viewport.height);
    expect(placeholders.hidden).toBe(true);
    expect(await loading.count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      viewport.width,
    );
    if (viewport.name === "desktop") {
      await page.setViewportSize({ width: 820, height: 1024 });
      expect(
        await loading.evaluate((status) => status.getBoundingClientRect().bottom),
      ).toBeGreaterThanOrEqual(1024);
      await capture(page, "loading-resized-tablet", loading);
    }
    // The first shelf and card arrive exactly where their placeholders were.
    const placeholderHeader = await loading
      .locator(".plugin-catalog-section__header")
      .first()
      .evaluate(rect);
    const placeholderCard = await loading
      .locator("[data-templates-placeholder]")
      .first()
      .evaluate(rect);
    await gateway.resolveDeferred("templates.catalog.search");
    const card = page.locator("[data-templates-entry]").first();
    await card.waitFor();
    expect(await loading.count()).toBe(0);
    expect(await card.evaluate(rect)).toEqual(placeholderCard);
    expect(await page.locator(".plugin-catalog-section__header").first().evaluate(rect)).toEqual(
      placeholderHeader,
    );
  });

  async function openDetail(page: Page) {
    const card = page.locator("[data-templates-explore] [data-templates-entry]").first();
    await card.locator(".agents-home__template-card-link").click();
    const detail = page.locator(".plugin-catalog-detail");
    await detail.getByRole("heading", { level: 1 }).waitFor();
    return detail;
  }

  it.each(["light", "dark"] as const)(
    "keeps headerless detail phone gutters on cold and Settings-warmed entry in %s",
    async (theme) => {
      const { page, gateway } = await fixture(
        { width: 390, height: 844 },
        undefined,
        undefined,
        false,
        theme,
      );
      const card = page.locator("[data-templates-explore] [data-templates-entry]").first();
      await card.waitFor();
      const templateUrl =
        server.baseUrl + "templates/packages/%40openclaw%2Fworkflow-operator?version=1.2.0";
      expect(await page.locator("html").getAttribute("data-theme-mode")).toBe(theme);
      await capture(page, "gutter-catalog-phone-" + theme, card);
      const detail = await openDetail(page);
      const checkInsets = async (stage: string, expected = [12, 12]) => {
        await capture(page, "gutter-" + stage + "-" + theme, detail);
        const geometry = await detail.evaluate((element) => {
          const content = element.closest("main.content")!;
          const box = element.getBoundingClientRect();
          const parent = content.getBoundingClientRect();
          return [
            Math.round(box.left - parent.left - content.clientLeft),
            Math.round(parent.left + content.clientLeft + content.clientWidth - box.right),
          ];
        });
        console.info("gutter geometry", stage, geometry);
        expect.soft(geometry, stage).toEqual(expected);
      };
      await checkInsets("detail-phone");
      for (const width of [820, 1400]) {
        await page.setViewportSize({ width, height: 1000 });
        await checkInsets("detail-" + width, [36, 36]);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(templateUrl);
      await detail.getByRole("heading", { level: 1, name: workflowOperator.displayName }).waitFor();
      await checkInsets("cold-phone");
      await evaluateControlUiContext(page, (app) => app.navigate("appearance"));
      await page.locator(".settings-section").first().waitFor();
      await evaluateControlUiContext(page, (app) => app.navigate("templates"));
      await openDetail(page);
      await checkInsets("warm-phone");
      await page.goto(
        new URL(pathForPluginCatalogEntry(inspection.catalog.plugin.id), server.baseUrl).href,
      );
      await detail
        .getByRole("heading", { level: 1, name: inspection.catalog.plugin.catalog.name })
        .waitFor();
      await detail.getByRole("heading", { level: 2, name: /^readme$/iu }).waitFor();
      await checkInsets("plugin-phone");
      for (const width of [820, 1400]) {
        await page.setViewportSize({ width, height: 1000 });
        await checkInsets("plugin-" + width, [36, 36]);
      }
      expect(await gateway.getRequests("plugins.catalog.get")).not.toHaveLength(0);
    },
  );

  async function expectPublisher(detail: Locator, handle: string, official: boolean) {
    const publisher = detail.locator(".plugin-catalog-detail__publisher");
    expect(await publisher.locator("strong").textContent()).toBe(official ? "OpenClaw" : handle);
    expect(await publisher.getByRole("link", { name: `@${handle}` }).getAttribute("href")).toBe(
      `https://clawhub.ai/${handle}`,
    );
    expect(await publisher.getByRole("img", { name: "Official" }).count()).toBe(Number(official));
  }

  it.each([viewports[0], viewports[3]])(
    "shows the release audit and facts in the plugin page's rail at $name width",
    async (viewport) => {
      const { page } = await fixture(viewport);
      const detail = await openDetail(page);
      const rail = detail.locator(".plugin-catalog-detail__sidebar");
      await capture(page, `detail-rail-${viewport.name}`, rail, rail);
      const audit = rail.locator(".plugin-catalog-detail__security");
      expect(await audit.getByRole("link").getAttribute("href")).toBe(auditUrl);
      await audit.getByText("Clean", { exact: true }).waitFor();
      expect(await audit.locator(".is-filled").count()).toBe(3);
      const date = (value: number) =>
        new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(value);
      expect(
        await rail
          .locator(
            ".plugin-metadata__facts > div:not(.plugin-catalog-detail__security, .plugin-metadata__section)",
          )
          .evaluateAll((rows) =>
            rows.map((row) => [
              row.querySelector("dt")!.textContent,
              row.querySelector("dd")!.textContent,
            ]),
          ),
      ).toEqual([
        ["Version", "1.2.0"],
        ["Updated", date(workflowOperator.updatedAtMs)],
        ["Published", date(publishedAtMs)],
        ["Downloads", "1.2k"],
      ]);
      expect(await rail.locator(".chip").allTextContents()).toEqual(["research", "productivity"]);
      const railBox = (await rail.boundingBox())!;
      const contents = (await detail.locator(".plugin-catalog-detail__panel").boundingBox())!;
      // The rail sits beside the contents on a wide page and after them in one column.
      if (viewport.name === "desktop") {
        expect(railBox.x).toBeGreaterThanOrEqual(contents.x + contents.width);
        expect(railBox.y).toBeLessThan(contents.y + contents.height);
      } else {
        expect(railBox.y).toBeGreaterThanOrEqual(contents.y + contents.height);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
    },
  );

  it.each(["light", "dark"] as const)(
    "explains the release audit from its info control while link previews are on in %s",
    async (theme) => {
      const { page } = await fixture(viewports[3], undefined, undefined, false, theme, true);
      const detail = await openDetail(page);
      const audit = detail.locator(".plugin-catalog-detail__security");
      const hint = page.getByRole("tooltip").filter({ hasText: /\S/u });
      const info = audit.getByRole("button");
      await info.hover();
      await hint.waitFor();
      // The audit link's page preview must not replace the hint once its delay passes.
      await page.waitForTimeout(LINK_READER_HOVERCARD_OPEN_DELAY_MS * 2);
      expect(await page.locator(".link-hovercard").count()).toBe(0);
      expect(await hint.textContent()).toBe(
        "ClawHub checks each release for vulnerabilities and agentic risk.",
      );
      await capture(page, `audit-info-${theme}`, audit, audit);
      // Clicking explains instead of following the audit link, and keeps the hint open.
      await info.click();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(LINK_READER_HOVERCARD_OPEN_DELAY_MS * 2);
      expect(await hint.count()).toBe(1);
      expect(page.url()).toContain("/templates/");
      expect(page.context().pages()).toHaveLength(1);
    },
  );

  it.each([viewports[0], viewports[3]])(
    "shows bundled and referenced contents at $name width",
    async (viewport) => {
      const { page, gateway } = await fixture(viewport);
      await gateway.setMethodResponse("templates.catalog.detail", {
        detail: {
          ...workflowOperator,
          version: "1.2.0",
          agentId: "workflow-operator",
          agentName: "Workflow Operator",
          contents: {
            instructions: [{ name: "AGENTS.md", source: "workspace/AGENTS.md" }],
            skills: [
              {
                name: "Local research",
                source: "bundled",
                path: "skills/research",
                excerpt: "Research public releases.",
              },
              {
                name: "Trip research",
                source: "clawhub",
                ref: "@openclaw/trip-research",
                version: "2.0.0",
              },
            ],
            integrations: [
              {
                name: "workflow-tools",
                kind: "plugin",
                source: "bundled",
                path: "plugins/workflow-tools",
              },
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
        },
      });
      const detail = await openDetail(page);
      await capture(
        page,
        `bundled-provenance-${viewport.name}`,
        detail.getByRole("heading", { name: "Skills" }),
      );
      expect(await detail.getByText("Bundled with template", { exact: true }).count()).toBe(0);
      expect(
        (await detail.locator(".plugin-capabilities").allTextContents()).join(" "),
      ).not.toContain("ClawHub · Version");
      expect(await detail.getByText("Installed", { exact: true }).count()).toBe(1);
      // The status shares the chevron's line at every width instead of stacking above it.
      const control = detail.locator(".settings-row__control", {
        has: page.locator(".plugin-connection-status"),
      });
      const status = (await control.locator(".plugin-connection-status").boundingBox())!;
      const chevron = (await control.locator(".settings-row__chevron").boundingBox())!;
      expect(
        Math.abs(status.y + status.height / 2 - (chevron.y + chevron.height / 2)),
      ).toBeLessThanOrEqual(1);
      expect(chevron.x).toBeGreaterThanOrEqual(status.x + status.width);
      expect(await detail.textContent()).not.toContain("undefined");
      expect(await detail.locator(".templates-add-review").count()).toBe(0);
      await capture(page, `template-detail-no-review-${viewport.name}`, detail);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
    },
  );

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
    expect(layout.clamp).toBe("1");
    expect(layout.height).toBeLessThanOrEqual(layout.lineHeight + 1);
    expect(layout.scrollHeight).toBeGreaterThan(layout.height);
  }

  it("lays out featured cards and switches category shelves to filtered results", async () => {
    const { page, gateway } = await fixture(
      undefined,
      undefined,
      undefined,
      false,
      "light",
      false,
      [
        workflowOperator,
        { ...researchTemplate, iconUrl: "/apple-touch-icon.png" },
        {
          ...workflowOperator,
          packageName: "@maker/inbox",
          displayName: "Inbox Organizer",
          ownerHandle: "maker",
        },
        {
          ...workflowOperator,
          packageName: "@maker/planner",
          displayName: "A long weekly planning Template name",
          ownerHandle: "a-long-publisher-handle",
        },
      ],
    );
    await page.locator("[data-templates-featured] [data-templates-entry]").first().waitFor();
    await page
      .locator('[data-templates-category="research"] [data-templates-entry]')
      .first()
      .waitFor();
    expect(
      await page
        .locator(".plugin-catalog-chips")
        .evaluate((element) => getComputedStyle(element).flexWrap),
    ).toBe("wrap");
    // All and the eleven category filters each have a distinct glyph.
    const chipIcons = await page
      .locator(".plugin-catalog-chips .plugin-catalog-chip svg")
      .evaluateAll((icons) => icons.map((icon) => icon.innerHTML));
    expect(chipIcons).toHaveLength(12);
    expect(new Set(chipIcons).size).toBe(chipIcons.length);
    const searchWidth = await page
      .locator(".plugin-catalog-search")
      .evaluate((element) => element.getBoundingClientRect().width);
    const bodyWidth = await page
      .locator(".plugin-catalog-results__body")
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(Math.abs(searchWidth - bodyWidth)).toBeLessThan(2);
    await capture(
      page,
      "after-catalog",
      page.locator("[data-templates-featured] [data-templates-entry]").first(),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await capture(page, "catalog-mobile", page.locator("[data-templates-featured]"));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const selector of ["[data-templates-featured]", '[data-templates-category="research"]']) {
      const cards = page.locator(`${selector} [data-templates-entry]`);
      expect(await cards.count()).toBe(4);
      const boxes = await cards.evaluateAll((elements) =>
        elements.map((card) => {
          const { x, y } = card.getBoundingClientRect();
          return { x, y };
        }),
      );
      expect(boxes[0]!.y).toBe(boxes[1]!.y);
      expect(boxes[2]!.y).toBe(boxes[3]!.y);
      expect(boxes[0]!.x).toBe(boxes[2]!.x);
      expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);
      expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y);
    }
    await gateway.waitForRequest("templates.catalog.search", {
      match: { overview: true, limit: 4 },
    });
    expect(await gateway.getRequests("templates.catalog.search")).toHaveLength(1);

    await gateway.setMethodResponse("templates.catalog.search", {
      entries: [researchTemplate, workflowOperator],
    });
    await page.getByRole("button", { name: "Research", exact: true }).click();
    await gateway.waitForRequest("templates.catalog.search", { match: { category: "research" } });
    await page.locator("[data-templates-results] [data-templates-entry]").first().waitFor();
    expect(await page.locator("[data-templates-featured]").count()).toBe(0);
    const categoryCards = page.locator("[data-templates-results] [data-templates-entry]");
    expect(await categoryCards.count()).toBe(2);
    expect(await categoryCards.first().textContent()).toContain("Release Scout");
    expect(await categoryCards.nth(1).textContent()).toContain("Workflow Operator");
  });
  it.each(viewports)(
    "shows the Template contents at $name width without empty sections",
    async (viewport) => {
      const { page, gateway } = await fixture(viewport);
      const card = page.locator("[data-templates-explore] [data-templates-entry]").first();
      await card.waitFor();
      expect(await card.textContent()).toContain("@openclaw");
      const detail = await openDetail(page);
      await page.waitForURL(
        /\/templates\/packages\/%40openclaw%2Fworkflow-operator\?version=1\.2\.0$/u,
      );
      await capture(
        page,
        `after-detail-${viewport.name}`,
        detail.getByRole("heading", { name: "Personality" }),
      );
      await expectPublisher(detail, "openclaw", true);
      await detail.getByText(soulExcerpt, { exact: true }).waitFor();
      expect(await gateway.getRequests("templates.catalog.preview")).toHaveLength(0);
      await expectClamped(detail.getByText(skillExcerpt, { exact: true }));
      expect(await detail.getByRole("heading", { name: "Plugins" }).count()).toBe(1);
      expect(await detail.getByRole("heading", { name: "Automations" }).count()).toBe(0);
      await detail.getByText("Installed", { exact: true }).waitFor();
      expect(await detail.locator(".plugin-connection-status svg").count()).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        viewport.width,
      );
      const fileContent = "Personality file content.";
      await gateway.setMethodResponse("templates.catalog.preview", {
        preview: { kind: "instruction", name: "SOUL.md", content: fileContent },
      });
      await detail.getByRole("button", { name: "SOUL.md", exact: true }).press("Enter");
      await gateway.waitForRequest("templates.catalog.preview", {
        match: { kind: "instruction", name: "SOUL.md" },
      });
      await page
        .getByRole("dialog", { name: "Workspace files", exact: true })
        .getByText(fileContent, { exact: true })
        .waitFor();
    },
  );

  it("keeps long Template names and publishers readable beside Add on a phone", async () => {
    const entry = {
      ...workflowOperator,
      packageName: "@international-travel-ops/departures",
      displayName: "International Travel Operations · Departures",
      ownerHandle: "international-travel-ops",
      channel: "community" as const,
      official: false,
    };
    const { page } = await fixture({ width: 390, height: 844 }, entry);
    const card = page.locator("[data-templates-featured] [data-templates-entry]").first();
    await card.waitFor();
    await page.evaluate(() => document.fonts.ready.then(() => {}));
    const readable = await card.evaluate((row) => {
      const add = row.querySelector(".agents-home__template-add")!.getBoundingClientRect();
      return [...row.querySelectorAll("h3, .plugin-card-author")].every((label) => {
        const bounds = label.getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(label);
        const lines = [...text.getClientRects()];
        return (
          lines.length > 0 &&
          lines.every(
            (line) =>
              line.left >= bounds.left - 1 &&
              line.right <= bounds.right + 1 &&
              line.right <= add.left,
          )
        );
      });
    });
    expect(readable, "the name and publisher both fit before Add").toBe(true);
  });

  it("reads and collapses the full SOUL.md when its excerpt already fits", async () => {
    const { page, gateway } = await fixture();
    await gateway.setMethodResponse("templates.catalog.detail", {
      detail: {
        ...workflowOperator,
        version: "1.2.0",
        agentId: "workflow-operator",
        contents: {
          instructions: [
            { name: "SOUL.md", source: "workspace/SOUL.md", excerpt: "Short excerpt." },
          ],
          skills: [],
          integrations: [],
          automations: [],
        },
      },
    });
    await gateway.setMethodResponse("templates.catalog.preview", {
      preview: {
        content:
          "A full instruction.\n\n![External illustration](https://example.invalid/soul.png)",
      },
    });
    const detail = await openDetail(page);
    const personality = detail.locator(".templates-personality");
    await personality.getByText("Short excerpt.", { exact: true }).waitFor();
    expect(await gateway.getRequests("templates.catalog.preview")).toHaveLength(0);
    await personality.getByRole("button", { name: "Show more", exact: true }).click({
      timeout: 5000,
    });
    await personality.getByText("A full instruction.", { exact: true }).waitFor();
    expect(await gateway.getRequests("templates.catalog.preview")).toHaveLength(1);
    expect(await personality.getByRole("img", { name: "External illustration" }).count()).toBe(0);
    await personality.getByRole("button", { name: "Show less", exact: true }).click();
    await personality.getByText("Short excerpt.", { exact: true }).waitFor();
  });

  it.each([viewports[0], viewports[3]])(
    "opens automation instructions from catalog and preview rows at $name width",
    async (viewport) => {
      const { page, gateway } = await fixture(
        { ...viewport, timezoneId: "America/Los_Angeles" },
        undefined,
        undefined,
        false,
        "dark",
      );
      const longMessage = weeklyAutomations[1]!.message + "\n\n" + "reference_".repeat(80);
      await gateway.setMethodResponse("templates.catalog.detail", {
        detail: {
          ...workflowOperator,
          version: "1.2.0",
          agentId: "workflow-operator",
          contents: {
            instructions: [{ name: "AGENTS.md", source: "AGENTS.md" }],
            skills: [],
            integrations: [],
            automations: [
              weeklyAutomations[0],
              { ...weeklyAutomations[1], enabled: true, message: longMessage },
            ],
          },
        },
      });
      const weekly = weeklyAutomations[0]!;
      const weeklySchedule = "Monday at 9:00 AM · America/Los_Angeles · Disabled";
      const detail = await openDetail(page);
      expect((await gateway.getRequests("connect")).at(-1)).toMatchObject({
        params: { client: { timeZone: "America/Los_Angeles" } },
      });
      const row = detail.getByRole("button", { name: /Weekly brief/ });
      const dialog = page.getByRole("dialog", { name: weekly.name, exact: true });
      const close = dialog.getByRole("button", { name: "Close", exact: true });
      const checkDialog = async () => {
        await dialog.getByRole("heading", { name: weekly.name, exact: true }).waitFor();
        await dialog.getByText(weeklySchedule, { exact: true }).waitFor();
        expect(await dialog.locator(".template-automation-message").textContent()).toBe(
          weekly.message,
        );
        expect(await close.count()).toBe(1);
        expect(await dialog.evaluate((element) => element.matches(":focus-within"))).toBe(true);
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      };
      await row.getByText(weeklySchedule, { exact: true }).waitFor();
      await row.press("Enter");
      await checkDialog();
      await capture(page, `automation-dialog-${viewport.name}`, dialog);
      await page.keyboard.press("Tab");
      expect(await close.evaluate((element) => element.matches(":focus"))).toBe(true);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(await row.evaluate((element) => element.matches(":focus"))).toBe(true);
      const midweek = detail.getByRole("button", { name: /Midweek nudge/ });
      await midweek
        .getByText("Wednesday at 9:00 PM · America/Los_Angeles · Enabled", { exact: true })
        .waitFor();
      await midweek.click();
      const second = page.getByRole("dialog", { name: "Midweek nudge", exact: true });
      const message = second.locator(".template-automation-message");
      expect(await message.textContent()).toBe(longMessage);
      expect(await message.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await second.getByRole("button", { name: "Close", exact: true }).click();
      await second.waitFor({ state: "hidden" });
      expect(await midweek.evaluate((element) => element.matches(":focus"))).toBe(true);

      await page.goto(`${server.baseUrl}chat/main`);
      await page.locator("a.markdown-template-link").first().click();
      const shell = page.getByRole("dialog", { name: "Template details", exact: true });
      await shell.getByRole("button", { name: /Automations/ }).click();
      const previewRow = shell.getByRole("button", { name: /Weekly brief/ });
      await previewRow.getByText(weeklySchedule, { exact: true }).waitFor();
      await previewRow.click();
      await checkDialog();
      await capture(page, `automation-preview-${viewport.name}`, dialog);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      expect(await previewRow.evaluate((element) => element.matches(":focus"))).toBe(true);
      expect(await gateway.getRequests("templates.add.apply")).toHaveLength(0);
    },
  );

  it("keeps the inline preview shell stable through category and file navigation", async () => {
    const { page, gateway } = await fixture();
    await gateway.setMethodResponse("templates.catalog.preview", {
      preview: {
        content: "Long file content. ".repeat(2000) + "\n\n[Agent instructions](AGENTS.md)",
      },
    });
    await page.goto(`${server.baseUrl}chat/main`);
    const references = page.locator("a.markdown-template-link");
    await references.first().hover();
    await page.locator(".template-reference-card").waitFor();
    await references.nth(1).hover();
    await page.waitForTimeout(250); // The first anchor’s 180 ms dismissal must not close the second.
    expect(await page.locator(".template-reference-card").isVisible()).toBe(true);
    await gateway.deferNext("plugins.list");
    await references.nth(1).click();
    const modal = page.getByRole("dialog", { name: "Template details", exact: true });
    const shell = modal.locator(".template-preview");
    await shell.getByRole("button", { name: /Workspace files/ }).waitFor();
    await expect.poll(async () => (await shell.boundingBox())?.width).toBe(960);
    const bounds = await shell.boundingBox();
    expect(bounds?.width).toBe(960);
    expect(bounds?.height).toBe(680);
    const header = await shell.locator("header").boundingBox();
    const footer = await shell.locator("footer").boundingBox();
    await shell.getByRole("button", { name: /Workspace files/ }).click();
    await shell.getByRole("button", { name: "SOUL.md", exact: true }).click();
    await shell.getByText("Long file content.", { exact: false }).first().waitFor();
    expect(await page.getByRole("dialog").count()).toBe(1);
    expect(await shell.boundingBox()).toEqual(bounds);
    await shell.locator(".template-preview__body").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(await shell.locator("header").boundingBox()).toEqual(header);
    expect(await shell.locator("footer").boundingBox()).toEqual(footer);
    await shell.getByRole("link", { name: "Agent instructions", exact: true }).click();
    await shell.getByRole("heading", { name: "AGENTS.md", exact: true }).waitFor();
    expect(await page.getByRole("dialog").count()).toBe(1);
    const back = shell.getByRole("button", { name: "Back to Workspace files", exact: true });
    expect(await back.textContent()).toBe("");
    await back.click();
    await shell.getByRole("button", { name: "Back to template", exact: true }).click();
    await shell.getByRole("button", { name: /Plugins/ }).click();
    const plugin = shell.getByRole("button", { name: "@openclaw/workflow-tools", exact: true });
    await plugin.locator(".skeleton").waitFor();
    await gateway.resolveDeferred("plugins.list");
    await shell.getByRole("button", { name: "Workflow Tools", exact: true }).waitFor();
    expect(await shell.boundingBox()).toEqual(bounds);
    expect(await gateway.getRequests("templates.add.apply")).toHaveLength(0);
    await evaluateControlUiContext(page, (app) => app.navigateAndWait("templates"));
    await modal.waitFor({ state: "hidden" });
    await evaluateControlUiContext(page, (app) =>
      app.navigateAndWait("chat", { pathname: "/chat/main" }),
    );
    await page.locator("a.markdown-template-link:visible").first().waitFor();
    expect(await modal.count()).toBe(0);
  });

  it("distinguishes an empty catalog from no matching templates", async () => {
    const { page, gateway } = await fixture();
    await page.locator("[data-templates-featured] [data-templates-entry]").first().waitFor();
    await gateway.setMethodResponse("templates.catalog.search", { entries: [] });
    const search = page.getByPlaceholder("Search templates");
    await search.fill("unmatched");
    await page.getByText("No templates match your search.", { exact: true }).waitFor();
    await search.fill("");
    await page.getByText("No templates yet.", { exact: true }).waitFor();
  });

  it("offers Add from the Template detail without requesting a plan", async () => {
    const { page, gateway } = await fixture();
    const detail = await openDetail(page);
    await expect
      .poll(() => detail.locator("[data-templates-confirm] button").isEnabled())
      .toBe(true);
    expect(await gateway.getRequests("templates.add.plan")).toHaveLength(0);
    expect(await gateway.getRequests("templates.add.apply")).toHaveLength(0);
  });

  it.each([400, 1280])(
    "returns a rolled-back Add to the catalog with the error on its card at %i px",
    async (width) => {
      const { page, gateway } = await fixture({ width, height: 900 });
      const card = page.locator("[data-templates-explore] [data-templates-entry]").first();
      const add = card.getByRole("button", { name: "Add", exact: false });
      await card.waitFor();
      await gateway.deferNext("templates.add.apply");
      await add.click();
      const apply = await gateway.waitForRequest("templates.add.apply");
      await page.waitForURL(/\/chat\/workflow-operator(?:\?|$)/u);
      const pending = page.locator("openclaw-pending-session-create");
      await pending.getByText("Creating new agent", { exact: true }).waitFor();
      // The Gateway admitted the agent and chat, then could not fetch the Template.
      await gateway.emitGatewayEvent("templates.add.progress", {
        requestId: apply.id,
        stage: "agent-admitted",
        agentId: "workflow-operator",
        sessionKey: "agent:workflow-operator:main",
      });
      await gateway.rejectDeferred("templates.add.apply", {
        code: "UNAVAILABLE",
        message: "ClawHub could not deliver this Template.",
      });
      await page.waitForURL(/\/templates(?:\?|$)/u);
      const alert = card.getByRole("alert");
      await alert.getByText("ClawHub could not deliver this Template.", { exact: true }).waitFor();
      await capture(page, `template-add-${width}-rolled-back`, card);
      // The chat cache retains its inert pane; no pending chat is presented.
      expect(await pending.filter({ visible: true }).count()).toBe(0);
      expect(await page.locator(".templates-add-consent").count()).toBe(0);
      // The message stays inside its card and the page does not scroll sideways.
      const [cardBox, alertBox] = await Promise.all([card.boundingBox(), alert.boundingBox()]);
      expect(alertBox!.x).toBeGreaterThanOrEqual(cardBox!.x);
      expect(alertBox!.x + alertBox!.width).toBeLessThanOrEqual(cardBox!.x + cardBox!.width);
      expect(alertBox!.y + alertBox!.height).toBeLessThanOrEqual(cardBox!.y + cardBox!.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await expect.poll(() => add.isEnabled()).toBe(true);
      expect(await gateway.getRequests("templates.add.apply")).toHaveLength(1);
      expect(await gateway.getRequests("templates.add.plan")).toHaveLength(0);
    },
  );

  it.each([400, 820, 1280])(
    "adds a personal Template directly from its card with stable chat and retained input at %i px",
    async (width) => {
      const community: ClawHubTemplateCatalogEntry = {
        ...workflowOperator,
        packageName: "@maker/workflow-operator",
        channel: "community",
        iconUrl: "/apple-touch-icon.png",
      };
      const { page, gateway } = await fixture({ width, height: 900 }, community, {
        ownerHandle: "maker",
        official: false,
      });
      await gateway.setHistoryMessages([]);
      await gateway.setSessionRow({
        key: "agent:workflow-operator:main",
        kind: "direct",
        sessionId: "template-empty-session",
        hasMessages: false,
      });
      await gateway.deferNext("chat.startup");
      const card = page.locator("[data-templates-explore] [data-templates-entry]").first();
      await card.waitFor();
      expect(await card.textContent()).toContain("@openclaw");
      expect(await card.getByRole("button", { name: "Add", exact: false }).isEnabled()).toBe(true);
      await gateway.deferNext("templates.add.apply");
      await page.evaluate(() => {
        const frames: Array<{
          chat: boolean;
          content: boolean;
          surface: string;
          headerY: number | null;
          emptyDom?: string;
        }> = [];
        let chatMounted = false;
        Object.assign(window, { templateAddFrames: frames, templateAddRecording: true });
        const sample = () => {
          const pane = document.querySelector(".chat-pane-cache__pane--visible");
          chatMounted ||= Boolean(pane);
          // URL updates before route commit. The retained catalog and visible
          // cold-route skeleton are real content, not an empty chat frame.
          const surface =
            pane ??
            (!chatMounted
              ? (document.querySelector("[data-templates-explore]") ??
                document.querySelector(".lazy-view-state--route[data-chat] .loading-skeleton"))
              : null);
          const content =
            surface instanceof HTMLElement &&
            surface.checkVisibility() &&
            Boolean(
              surface.textContent?.trim() ||
              (surface.matches(".loading-skeleton") && surface.getBoundingClientRect().height > 0),
            );
          frames.push({
            chat: location.pathname.includes("/chat/workflow-operator"),
            content,
            surface: pane
              ? "chat"
              : surface?.matches(".loading-skeleton")
                ? "loading"
                : surface
                  ? "catalog"
                  : "none",
            headerY:
              pane?.querySelector(".sidebar-region__header")?.getBoundingClientRect().y ?? null,
            ...(!content && location.pathname.includes("/chat/workflow-operator")
              ? { emptyDom: document.body.outerHTML }
              : {}),
          });
          if (Reflect.get(window, "templateAddRecording")) {
            requestAnimationFrame(sample);
          }
        };
        requestAnimationFrame(sample);
      });
      await capture(page, `template-add-${width}-catalog`, card);
      await card.getByRole("button", { name: "Add", exact: false }).click();
      const apply = await gateway.waitForRequest("templates.add.apply");
      // The roster names the agent only once the Gateway has it; Add asked for an id
      // the roster did not use.
      await gateway.setMethodResponse("agents.list", {
        ...agentsList,
        agents: [...agentsList.agents, { id: "workflow-operator", name: "Workflow Operator" }],
      });
      await page.waitForURL(/\/chat\/workflow-operator(?:\?|$)/u);
      const pending = page.locator("openclaw-pending-session-create");
      await pending.getByText("Creating new agent", { exact: true }).waitFor();
      if (width >= 1200) {
        // The agent being created wears its Template's catalog image, not a generated face.
        const avatar = page.locator(".sidebar-agent-card__avatar img").first();
        await avatar.waitFor();
        expect(await avatar.getAttribute("src")).toMatch(/^data:image\/png;base64,/u);
      }
      expect(await pending.locator("textarea").isEnabled()).toBe(true);
      await pending.locator("textarea").fill("Keep my draft while setup finishes");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      const pendingFooter = await pending.locator(".chat-footer").boundingBox();
      await capture(page, `template-add-${width}-pending`, pending);
      await gateway.emitGatewayEvent("templates.add.progress", {
        requestId: "unrelated-request",
        stage: "agent-ready",
        agentId: "workflow-operator",
        sessionKey: "agent:workflow-operator:main",
      });
      expect(await pending.locator("textarea").inputValue()).toBe(
        "Keep my draft while setup finishes",
      );
      await gateway.emitGatewayEvent("templates.add.progress", {
        requestId: apply.id,
        stage: "agent-ready",
        agentId: "workflow-operator",
        sessionKey: "agent:workflow-operator:main",
      });
      await pending.waitFor({ state: "hidden" });
      const composer = page.locator(".chat-pane-cache__pane--visible textarea");
      await composer.waitFor();
      await expect.poll(() => composer.isEnabled()).toBe(true);
      await expect.poll(() => composer.inputValue()).toBe("Keep my draft while setup finishes");
      const admittedPane = page.locator(".chat-pane-cache__pane--visible");
      const admittedFooter = await admittedPane.locator(".chat-footer").boundingBox();
      expect(admittedFooter).not.toBeNull();
      expect(pendingFooter).not.toBeNull();
      expect(Math.abs(admittedFooter!.y - pendingFooter!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(admittedFooter!.height - pendingFooter!.height)).toBeLessThanOrEqual(1);
      await capture(page, `template-add-${width}-admitted`, admittedPane);
      // The session description proves there are no saved messages, even
      // while setup and the first history response remain pending.
      await gateway.waitForRequest("sessions.messages.subscribe", {
        match: { key: "agent:workflow-operator:main" },
      });
      expect(await admittedPane.locator(".creation-composer").count()).toBe(1);
      const transcriptSkeleton = admittedPane.locator(
        ".chat-thread .chat-conversation-loading, .chat-thread .loading-skeleton, .chat-thread openclaw-panel-loading-skeleton",
      );
      expect(await transcriptSkeleton.count()).toBe(0);
      await gateway.resolveDeferred("templates.add.apply", {
        agentId: "workflow-operator",
        sessionKey: "agent:workflow-operator:main",
        status: "complete",
        readiness: { ready: false },
      });
      await admittedPane.locator(".creation-composer").waitFor({ state: "hidden" });
      expect(await transcriptSkeleton.count()).toBe(0);
      await gateway.resolveDeferred("chat.startup");
      expect(await composer.inputValue()).toBe("Keep my draft while setup finishes");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      // One Add request, with no plan digest or acknowledgements, and no review first.
      expect(apply.params).toEqual({
        mode: "chat",
        source: { packageName: community.packageName, version: "1.2.0" },
        agentId: "workflow-operator",
      });
      expect(await gateway.getRequests("templates.add.apply")).toHaveLength(1);
      expect(await gateway.getRequests("templates.add.plan")).toHaveLength(0);
      expect(await page.locator(".templates-add-consent").count()).toBe(0);
      // A card names no agent, so its Add reads the release detail once.
      expect(await gateway.getRequests("templates.catalog.detail")).toHaveLength(1);
      expect(await gateway.getRequests("templates.status")).toHaveLength(0);
      const frames = await page.evaluate(() => {
        Reflect.set(window, "templateAddRecording", false);
        return Reflect.get(window, "templateAddFrames") as Array<{
          chat: boolean;
          content: boolean;
          surface: string;
          headerY: number | null;
        }>;
      });
      await writeFile(
        `${proofDir}/template-add-${width}-frames.json`,
        JSON.stringify(frames, null, 2),
      );
      expect(frames.filter((frame) => frame.chat && !frame.content)).toEqual([]);
      const positions = frames.flatMap((frame) => (frame.headerY === null ? [] : [frame.headerY]));
      expect(positions.length).toBeGreaterThan(0);
      expect(Math.max(...positions) - Math.min(...positions)).toBeLessThanOrEqual(1);
    },
  );
});
