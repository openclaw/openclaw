import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { PluginsListResult } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { joinClawHubPluginCatalog } from "../../../src/plugins/catalog-discovery.js";
import { projectPluginCatalogCategoryFacts } from "../../../src/plugins/management-catalog.js";
import { metadataSnapshot } from "../../../src/plugins/management-service.test-helpers.js";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  discoveryCategories,
  discoveryResult,
} from "../test-helpers/plugins-e2e-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { named } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Plugins workspace navigation",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const methodResponses = {
  "config.get": {
    config: {},
    sourceConfig: {},
    hash: "plugins-workspace-config",
    issues: [],
    raw: "{}",
    valid: true,
  },
  "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
  "plugins.catalog.browse": discoveryResult,
  "plugins.catalog.categories": discoveryCategories,
  "skills.search": {
    results: [
      {
        slug: "calendar",
        installRef: "@fixture/calendar",
        displayName: "Calendar",
        score: 1,
        registry: "https://clawhub.ai",
      },
    ],
  },
  "skills.library.list": {
    entries: [],
    profileId: "alice",
    multipleProfiles: true,
    defaultTarget: "personal",
    canManageWorkspace: true,
    defaultSelectionLimit: 64,
  },
};

type HeaderGeometry = Awaited<ReturnType<typeof headerGeometry>>;

async function headerGeometry(page: Page) {
  const header = page.locator(".plugins-hub-header");
  await header.waitFor({ state: "visible" });
  return header.evaluate((element) => {
    const { left, top, width } = element.getBoundingClientRect();
    return { left, top, width, title: element.querySelector("h1")?.textContent?.trim() ?? "" };
  });
}

function expectStableHeader(actual: HeaderGeometry, expected: HeaderGeometry) {
  expect(Math.abs(actual.left - expected.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.top - expected.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(1);
}

async function expectHeaderCopy(page: Page, active: "plugins" | "skills" | "skill-workshop") {
  const [title, subtitle, docsPath] = (
    {
      plugins: ["Plugins", "Extend your Claw with tools", "plugins/manage-plugins"],
      skills: ["Skills", "Manage your agent skills", "tools/skills"],
      "skill-workshop": [
        "Skill workshop",
        "Skills your agent learned, recent changes, and undo.",
        "tools/skill-workshop",
      ],
    } as const
  )[active];
  const header = page.locator(".plugins-hub-header");
  expect(await header.getByRole("heading", { level: 1 }).textContent()).toBe(title);
  await expect
    .poll(() =>
      header.evaluate((element) => {
        const titleBox = element.querySelector(".page-title")?.getBoundingClientRect();
        const intro = element.querySelector(".hub-page-header__title")?.getBoundingClientRect();
        const tabs = element.querySelector(".hub-page-header__tabs")?.getBoundingClientRect();
        if (!titleBox || !intro || !tabs) {
          return null;
        }
        return {
          visibleTitle: titleBox.width > 1 && titleBox.height > 1,
          leftAligned: Math.abs(tabs.left - titleBox.left) <= 1,
          tabsBelowIntro: tabs.top >= intro.bottom,
        };
      }),
    )
    .toEqual({ visibleTitle: true, leftAligned: true, tabsBelowIntro: true });
  expect(await header.locator(".page-subtitle").textContent()).toContain(subtitle);
  expect(await header.getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe(
    `https://docs.openclaw.ai/${docsPath}`,
  );
}

async function installButtonPresentation(page: Page) {
  const button = page.getByRole("button", { name: /^Install /u }).first();
  await button.waitFor({ state: "visible" });
  return button.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.color,
      border: style.border,
      padding: style.padding,
      font: style.font,
      height: element.getBoundingClientRect().height,
    };
  });
}

async function expectActivePanelLabel(page: Page, labelId: string) {
  const panel = page.locator("#plugins-hub-panel");
  await panel.waitFor({ state: "visible" });
  expect(await panel.getAttribute("aria-labelledby")).toBe(labelId);
  expect(await page.locator(`#${labelId}`).count()).toBe(1);
}

const catalogMethods = ["plugins.list", "plugins.catalog.browse", "plugins.catalog.categories"];
function withWorkspace(
  viewport: { height: number; width: number },
  scenario: Parameters<typeof installMockGateway>[1],
  run: (page: Page, gateway: Awaited<ReturnType<typeof installMockGateway>>) => Promise<void>,
) {
  return suite.withPage(
    { locale: "en-US", serviceWorkers: "block", viewport },
    async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: catalogMethods,
        methodResponses,
        ...scenario,
      });
      await run(page, gateway);
    },
  );
}

async function expectWorkspace(
  page: Page,
  active: "plugins" | "skills" | "skill-workshop",
  baseline?: HeaderGeometry,
) {
  await waitForControlUiRoute(page, {
    pathname: active === "skill-workshop" ? "/skills/workshop" : `/${active}`,
    routeId: active,
  });
  const header = await headerGeometry(page);
  if (baseline) {
    expectStableHeader(header, baseline);
  }
  await expectHeaderCopy(page, active);
  await expectActivePanelLabel(page, `plugins-tab-${active}`);
  return header;
}

suite.define(() => {
  it("keeps model-provider video capabilities discoverable in Media across pagination", async () => {
    const local: PluginsListResult = {
      plugins: ["novita", "zai"].map((id) => {
        const snapshot = metadataSnapshot({
          enabled: true,
          id,
          name: id === "zai" ? "Z.AI" : "Novita",
          categories: ["models"],
          contracts: { videoGenerationProviders: [id] },
        });
        const plugin: PluginsListResult["plugins"][number] = {
          id,
          name: id === "zai" ? "Z.AI" : "Novita",
          packageName: "@openclaw/" + id,
          clawhubPackage: "@openclaw/" + id,
          origin: "bundled",
          installed: true,
          enabled: true,
          state: "enabled" as const,
          description: "Model inference and video generation.",
        };
        return Object.assign(
          plugin,
          projectPluginCatalogCategoryFacts(snapshot.byPluginId.get(id), plugin.enabled),
        );
      }),
      diagnostics: [],
      mutationAllowed: true,
    };
    expect(local.plugins.map((plugin) => plugin.categories)).toEqual([["models"], ["models"]]);
    expect(local.plugins.map((plugin) => plugin.capabilityCategories)).toEqual([
      ["media"],
      ["media"],
    ]);
    const fal = {
      packageName: "@openclaw/fal",
      displayName: "fal",
      family: "code-plugin" as const,
      isOfficial: true,
      categories: ["media"],
      summary: "Image, video, and music generation.",
      downloads: 1000,
    };
    const browse = (
      inventory: PluginsListResult,
      category?: string,
      cursor?: string,
      published = false,
    ) => ({
      items: joinClawHubPluginCatalog({
        local: inventory,
        intent: "all",
        includeBundledOnly: true,
        category,
        cursor,
        remote: published
          ? [
              {
                ...fal,
                packageName: "@openclaw/novita",
                displayName: "Novita",
                categories: ["models"],
              },
            ]
          : [fal].filter((plugin) => !category || plugin.categories.includes(category)),
        categories: discoveryCategories.categories,
      }),
      ...(!category ? { categories: discoveryCategories.categories } : {}),
      ...(category === "media" && !cursor ? { nextCursor: "media-page-two" } : {}),
    });
    await withWorkspace(
      { width: 1200, height: 928 },
      {
        methodResponses: {
          ...methodResponses,
          "plugins.list": local,
          "plugins.catalog.browse": browse(local),
        },
      },
      async (page, gateway) => {
        await page.goto(suite.server.baseUrl + "plugins");
        const chips = page.locator(".plugin-catalog-chips");
        await named(chips, "button", "Media").waitFor();
        const cards = page.locator(".plugin-catalog-card:not(.plugin-catalog-card--skeleton)");
        const expectFilteredCards = async (category: string, names: string[]) => {
          await expect
            .poll(async () => ({
              selected: await named(chips, "button", category).getAttribute("aria-pressed"),
              names: await page
                .locator(".plugin-catalog-grid--results .plugin-catalog-card__primary-link")
                .evaluateAll((links) =>
                  links.map((link) => link.getAttribute("aria-label") ?? "").toSorted(),
                ),
            }))
            .toEqual({ selected: "true", names: names.toSorted() });
        };

        await expect
          .poll(() => page.locator('[data-catalog-section="models"] .plugin-catalog-card').count())
          .toBe(2);
        await expect
          .poll(() => page.locator('[data-catalog-section="media"] .plugin-catalog-card').count())
          .toBe(3);

        const priorModels = (
          await gateway.getRequests("plugins.catalog.browse", { category: "models" })
        ).length;
        await gateway.setMethodResponse("plugins.catalog.browse", browse(local, "models"));
        await named(chips, "button", "Models").click();
        await gateway.waitForRequest("plugins.catalog.browse", {
          after: priorModels,
          match: { category: "models" },
        });
        await expectFilteredCards("Models", ["Novita", "Z.AI"]);

        const priorMedia = (
          await gateway.getRequests("plugins.catalog.browse", { category: "media" })
        ).length;
        await gateway.setMethodResponse("plugins.catalog.browse", browse(local, "media"));
        await named(chips, "button", "Media").click();
        await gateway.waitForRequest("plugins.catalog.browse", {
          after: priorMedia,
          match: { category: "media" },
        });
        await expectFilteredCards("Media", ["fal", "Novita", "Z.AI"]);
        for (const name of ["Novita", "Z.AI"]) {
          expect(await cards.filter({ hasText: name }).count()).toBe(1);
        }

        await gateway.setMethodResponse(
          "plugins.catalog.browse",
          browse(local, "media", "media-page-two", true),
        );
        await named(page, "button", "Load more").click();
        await gateway.waitForRequest("plugins.catalog.browse", {
          match: { category: "media", cursor: "media-page-two" },
        });
        await expect.poll(() => named(page, "button", "Load more").count()).toBe(0);
        expect(await cards.count()).toBe(3);
        expect(await cards.filter({ hasText: "Novita" }).count()).toBe(1);
      },
    );
  });

  it("loads category filters independently of cards and recovers a failed category read", async () => {
    await withWorkspace(
      { width: 1200, height: 928 },
      {
        deferredMethods: ["plugins.catalog.browse", "plugins.catalog.categories"],
      },
      async (page, gateway) => {
        await page.goto(`${suite.server.baseUrl}plugins`);
        await gateway.waitForRequest("plugins.catalog.browse");
        const chips = page.locator(".plugin-catalog-chips");
        await chips.locator(".plugin-catalog-chip--skeleton").first().waitFor();
        expect(await chips.getByRole("button").count()).toBe(3);
        expect(await named(chips, "button", "All").isEnabled()).toBe(true);
        await expectHeaderCopy(page, "plugins");
        await gateway.rejectDeferred("plugins.catalog.categories", {
          message: "Categories temporarily unavailable",
        });
        const error = page
          .getByRole("alert")
          .filter({ hasText: "Categories temporarily unavailable" });
        await error.waitFor();
        expect(await chips.locator(".plugin-catalog-chip--skeleton").count()).toBe(0);
        await error.getByRole("button", { name: "Try again" }).click();
        await named(chips, "button", "Channels").waitFor();
        expect(await page.locator(".plugin-catalog-grid--skeleton").count()).toBeGreaterThan(0);
        expect(await chips.locator(".plugin-catalog-chip--skeleton").count()).toBe(0);
        expect(await gateway.getRequests("plugins.catalog.categories")).toHaveLength(2);
        await gateway.resolveDeferred("plugins.catalog.browse");
        await page
          .locator(".plugin-catalog-card:not(.plugin-catalog-card--skeleton)")
          .first()
          .waitFor();
        await named(chips, "button", "Featured").click();
        await gateway.waitForRequest("plugins.catalog.browse", { match: { intent: "featured" } });
        expect(await gateway.getRequests("plugins.catalog.categories")).toHaveLength(2);
      },
    );
  });

  it("redirects the retired discovery URL to the Plugins workspace", async () => {
    await withWorkspace(
      { height: 768, width: 1366 },
      { featureMethods: ["config.get", ...catalogMethods] },
      async (page) => {
        await page.goto(`${suite.server.baseUrl}settings/plugins/discover?query=calendar#featured`);
        await waitForControlUiRoute(page, { pathname: "/plugins", routeId: "plugins" });
        const location = new URL(page.url());
        expect(`${location.pathname}${location.search}${location.hash}`).toBe(
          "/plugins?query=calendar#featured",
        );
        await named(page, "searchbox", "Search plugins").waitFor();
      },
    );
  });

  it.each([
    { label: "desktop", viewport: { height: 1053, width: 2048 } },
    { label: "laptop", viewport: { height: 928, width: 1200 } },
    { label: "tablet", viewport: { height: 1024, width: 768 } },
    { label: "narrow", viewport: { height: 852, width: 393 } },
  ])(
    "keeps the Plugins/Skills shell coherent through every $label transition",
    async ({ viewport }) => {
      await withWorkspace(
        viewport,
        {
          featureMethods: [
            "agents.list",
            "config.get",
            ...catalogMethods,
            "skills.workshop.changes",
            "skills.workshop.list",
            "skills.status",
            "skills.search",
            "skills.library.list",
          ],
        },
        async (page) => {
          await page.goto(`${suite.server.baseUrl}plugins`);
          await page.addStyleTag({
            content:
              "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
          });
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await named(page, "searchbox", "Search plugins").waitFor();
          const pluginsHeader = await expectWorkspace(page, "plugins");
          expect(await page.locator(".plugins-hub-tabs").getByRole("tab").count()).toBe(3);
          expect(await named(page, "tab", "Plugins").getAttribute("active")).not.toBeNull();
          expect(await page.getByRole("tab", { name: /Installed|Discover/u }).count()).toBe(0);
          expect(await page.locator(".plugins-tabs").count()).toBe(1);
          expect(await page.locator(".plugins-tabs.oc-segmented").count()).toBe(0);
          const tabBox = await page.locator(".plugins-tabs").boundingBox();
          const pluginTabBox = await named(page, "tab", "Plugins").boundingBox();
          expect(tabBox).not.toBeNull();
          expect(pluginTabBox).not.toBeNull();
          expect(pluginTabBox?.height ?? 0).toBeLessThanOrEqual(36);
          const pluginInstallPresentation = await installButtonPresentation(page);

          const skillsTab = named(page.locator(".plugins-hub-tabs"), "tab", "Skills");
          await skillsTab.focus();
          await page.keyboard.press("Enter");
          await waitForControlUiRoute(page, { pathname: "/skills", routeId: "skills" });
          await expect
            .poll(() =>
              named(page, "searchbox", "Search skills").evaluate(
                (input) => input === document.activeElement,
              ),
            )
            .toBe(true);
          await expectWorkspace(page, "skills", pluginsHeader);
          expect(await installButtonPresentation(page)).toEqual(pluginInstallPresentation);

          const workshopTab = named(page, "tab", "Skill workshop");
          await workshopTab.focus();
          await page.keyboard.press("Enter");
          await waitForControlUiRoute(page, {
            pathname: "/skills/workshop",
            routeId: "skill-workshop",
          });
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  document.activeElement?.id ||
                  document.activeElement?.getAttribute("aria-label") ||
                  document.activeElement?.tagName,
              ),
            )
            .toBe("plugins-tab-skill-workshop");
          await expectWorkspace(page, "skill-workshop", pluginsHeader);
          expect(await named(page, "tab", "Skill workshop").getAttribute("active")).not.toBeNull();

          await named(page.locator(".plugins-hub-tabs"), "tab", "Skills").click();
          await expectWorkspace(page, "skills", pluginsHeader);
          await named(page, "tab", "Plugins").click();
          await expectWorkspace(page, "plugins", pluginsHeader);
        },
      );
    },
  );
});
