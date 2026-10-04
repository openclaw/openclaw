import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { PluginsListResult } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { joinClawHubPluginCatalog } from "../../../src/plugins/catalog-discovery.js";
import { projectPluginCatalogCategoryFacts } from "../../../src/plugins/management-catalog.js";
import { metadataSnapshot } from "../../../src/plugins/management-service.test-helpers.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  discoveryCategories,
  discoveryResult,
} from "../test-helpers/plugins-e2e-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Plugins workspace navigation",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("plugins-workspace-shell");
  }
});

const methodResponses = {
  "agents.list": {
    agents: [
      { id: "main", identity: { name: "Main" }, name: "Main" },
      { id: "reviewer", identity: { name: "Reviewer" }, name: "Reviewer" },
    ],
    defaultId: "main",
    mainKey: "main",
    scope: "agent",
  },
  "config.get": {
    config: {},
    sourceConfig: {},
    hash: "plugins-workspace-config",
    issues: [],
    raw: "{}",
    valid: true,
  },
  "plugins.list": {
    plugins: [
      {
        id: "workboard",
        name: "Workboard",
        description: "Dashboard workboard for agent-owned issues and sessions.",
        kind: ["productivity"],
        origin: "bundled",
        installed: true,
        enabled: true,
        state: "enabled",
        category: "tool",
        removable: false,
      },
    ],
    diagnostics: [],
    mutationAllowed: true,
  },
  "plugins.catalog.browse": discoveryResult,
  "plugins.catalog.categories": discoveryCategories,
  "skills.proposals.historyStatus": {
    hasScanned: false,
    hasMore: false,
    ideasFound: 0,
    reviewedSessions: 0,
    lastScanReviewed: 0,
  },
  "skills.proposals.list": {
    proposals: [],
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt: "2026-08-17T12:00:00.000Z",
  },
  "skills.status": {
    workspaceDir: "/tmp/openclaw-e2e/workspace",
    managedSkillsDir: "/tmp/openclaw-e2e/skills",
    skills: [],
  },
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

type HeaderGeometry = {
  height: number;
  left: number;
  title: string;
  top: number;
  width: number;
};

async function createContext(viewport: { height: number; width: number }): Promise<BrowserContext> {
  return suite.browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport,
    ...(captureUiProof ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
  });
}

async function headerGeometry(page: Page): Promise<HeaderGeometry> {
  const header = page.locator(".plugins-hub-header");
  await header.waitFor({ state: "visible" });
  return header.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      height: rect.height,
      left: rect.left,
      title: element.querySelector("h1")?.textContent?.trim() ?? "",
      top: rect.top,
      width: rect.width,
    };
  });
}

function expectStableHeader(actual: HeaderGeometry, expected: HeaderGeometry) {
  expect(Math.abs(actual.left - expected.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.top - expected.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.width - expected.width)).toBeLessThanOrEqual(1);
}

async function expectHeaderCopy(page: Page, active: "plugins" | "skills" | "skill-workshop") {
  const expected = {
    plugins: {
      title: "Plugins",
      subtitle: "Extend your Claw with tools",
      docs: "https://docs.openclaw.ai/plugins/manage-plugins",
    },
    skills: {
      title: "Skills",
      subtitle: "Manage your agent skills",
      docs: "https://docs.openclaw.ai/tools/skills",
    },
    "skill-workshop": {
      title: "Skill workshop",
      subtitle:
        "The skills your agent uses now, suggestions waiting for review, and past decisions.",
      docs: "https://docs.openclaw.ai/tools/skill-workshop",
    },
  }[active];
  const header = page.locator(".plugins-hub-header");
  expect(await header.getByRole("heading", { level: 1 }).textContent()).toBe(expected.title);
  // All three routes share the settings-style header. Allow subtitle wrapping
  // to change its height, but keep the visible title and tabs left-aligned.
  await expect
    .poll(() =>
      header.evaluate((element) => {
        const title = element.querySelector(".page-title")?.getBoundingClientRect();
        const intro = element.querySelector(".hub-page-header__title")?.getBoundingClientRect();
        const tabs = element.querySelector(".hub-page-header__tabs")?.getBoundingClientRect();
        if (!title || !intro || !tabs) {
          return null;
        }
        return {
          visibleTitle: title.width > 1 && title.height > 1,
          leftAligned: Math.abs(tabs.left - title.left) <= 1,
          tabsBelowIntro: tabs.top >= intro.bottom,
        };
      }),
    )
    .toEqual({ visibleTitle: true, leftAligned: true, tabsBelowIntro: true });
  expect(await header.locator(".page-subtitle").textContent()).toContain(expected.subtitle);
  expect(await header.getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe(
    expected.docs,
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

async function captureScreenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await writeFile(
    path.join(proofDir, name),
    await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
      page.locator(".plugins-hub-tabs"),
    ]),
  );
}

async function expectActivePanelLabel(page: Page, labelId: string) {
  const panel = page.locator("#plugins-hub-panel");
  await panel.waitFor({ state: "visible" });
  expect(await panel.getAttribute("aria-labelledby")).toBe(labelId);
  expect(await page.locator(`#${labelId}`).count()).toBe(1);
}

suite.define(() => {
  it("keeps model-provider video capabilities discoverable in Media across pagination", async () => {
    const context = await createContext({ width: 1200, height: 928 });
    const page = await context.newPage();
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
    // The baseline used the same purpose metadata but published no derived membership.
    // Both captures render the real UI; only the Gateway catalog input differs.
    const before = {
      ...local,
      plugins: local.plugins.map((plugin) => {
        const previous = { ...plugin };
        delete previous.capabilityCategories;
        return previous;
      }),
    };
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
    const gateway = await installMockGateway(page, {
      featureMethods: ["plugins.list", "plugins.catalog.browse", "plugins.catalog.categories"],
      methodResponses: {
        ...methodResponses,
        "plugins.list": local,
        "plugins.catalog.browse": browse(captureUiProof ? before : local),
      },
    });
    try {
      await page.goto(suite.server.baseUrl + "plugins");
      const chips = page.locator(".plugin-catalog-chips");
      await chips.getByRole("button", { name: "Media", exact: true }).waitFor();
      const cards = page.locator(".plugin-catalog-card:not(.plugin-catalog-card--skeleton)");
      const expectFilteredCards = async (category: string, names: string[]) => {
        await expect
          .poll(async () => ({
            selected: await chips
              .getByRole("button", { name: category, exact: true })
              .getAttribute("aria-pressed"),
            names: await page
              .locator(".plugin-catalog-grid--results .plugin-catalog-card__primary-link")
              .evaluateAll((links) =>
                links.map((link) => link.getAttribute("aria-label") ?? "").toSorted(),
              ),
          }))
          .toEqual({ selected: "true", names: names.toSorted() });
      };
      if (captureUiProof) {
        await gateway.setMethodResponse("plugins.catalog.browse", browse(before, "models"));
        await chips.getByRole("button", { name: "Models", exact: true }).click();
        await gateway.waitForRequest("plugins.catalog.browse", { match: { category: "models" } });
        await expectFilteredCards("Models", ["Novita", "Z.AI"]);
        await captureScreenshot(page, "models-discovery-before.png");
        await gateway.setMethodResponse("plugins.catalog.browse", browse(before, "media"));
        await chips.getByRole("button", { name: "Media", exact: true }).click();
        await gateway.waitForRequest("plugins.catalog.browse", { match: { category: "media" } });
        await expectFilteredCards("Media", ["fal"]);
        await captureScreenshot(page, "media-discovery-before.png");
        await gateway.setMethodResponse("plugins.catalog.browse", browse(local));
        await chips.getByRole("button", { name: "All", exact: true }).click();
      }
      await expect
        .poll(() => page.locator('[data-catalog-section="models"] .plugin-catalog-card').count())
        .toBe(2);
      await expect
        .poll(() => page.locator('[data-catalog-section="media"] .plugin-catalog-card').count())
        .toBe(3);
      if (captureUiProof) {
        const priorModels = (
          await gateway.getRequests("plugins.catalog.browse", { category: "models" })
        ).length;
        await gateway.setMethodResponse("plugins.catalog.browse", browse(local, "models"));
        await chips.getByRole("button", { name: "Models", exact: true }).click();
        await gateway.waitForRequest("plugins.catalog.browse", {
          after: priorModels,
          match: { category: "models" },
        });
        await expectFilteredCards("Models", ["Novita", "Z.AI"]);
        await captureScreenshot(page, "models-discovery-after.png");
      }
      const priorMedia = (
        await gateway.getRequests("plugins.catalog.browse", { category: "media" })
      ).length;
      await gateway.setMethodResponse("plugins.catalog.browse", browse(local, "media"));
      await chips.getByRole("button", { name: "Media", exact: true }).click();
      await gateway.waitForRequest("plugins.catalog.browse", {
        after: priorMedia,
        match: { category: "media" },
      });
      await expectFilteredCards("Media", ["fal", "Novita", "Z.AI"]);
      for (const name of ["Novita", "Z.AI"]) {
        expect(await cards.filter({ hasText: name }).count()).toBe(1);
      }
      await captureScreenshot(page, "media-discovery-after.png");
      await gateway.setMethodResponse(
        "plugins.catalog.browse",
        browse(local, "media", "media-page-two", true),
      );
      await page.getByRole("button", { name: "Load more", exact: true }).click();
      await gateway.waitForRequest("plugins.catalog.browse", {
        match: { category: "media", cursor: "media-page-two" },
      });
      await expect
        .poll(() => page.getByRole("button", { name: "Load more", exact: true }).count())
        .toBe(0);
      expect(await cards.count()).toBe(3);
      expect(await cards.filter({ hasText: "Novita" }).count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("loads category filters independently of cards and recovers a failed category read", async () => {
    const context = await createContext({ width: 1200, height: 928 });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["plugins.list", "plugins.catalog.browse", "plugins.catalog.categories"],
      deferredMethods: ["plugins.catalog.browse", "plugins.catalog.categories"],
      methodResponses,
    });
    try {
      await page.goto(`${suite.server.baseUrl}plugins`);
      await gateway.waitForRequest("plugins.catalog.browse");
      const chips = page.locator(".plugin-catalog-chips");
      await chips.locator(".plugin-catalog-chip--skeleton").first().waitFor();
      expect(await chips.getByRole("button").count()).toBe(3);
      expect(await chips.getByRole("button", { name: "All", exact: true }).isEnabled()).toBe(true);
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
      await chips.getByRole("button", { name: "Channels", exact: true }).waitFor();
      expect(await page.locator(".plugin-catalog-grid--skeleton").count()).toBeGreaterThan(0);
      expect(await chips.locator(".plugin-catalog-chip--skeleton").count()).toBe(0);
      expect(await gateway.getRequests("plugins.catalog.categories")).toHaveLength(2);
      await gateway.resolveDeferred("plugins.catalog.browse");
      await page
        .locator(".plugin-catalog-card:not(.plugin-catalog-card--skeleton)")
        .first()
        .waitFor();
      await chips.getByRole("button", { name: "Featured", exact: true }).click();
      await gateway.waitForRequest("plugins.catalog.browse", { match: { intent: "featured" } });
      expect(await gateway.getRequests("plugins.catalog.categories")).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("redirects the retired discovery URL to the Plugins workspace", async () => {
    const context = await createContext({ height: 768, width: 1366 });
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: [
        "config.get",
        "plugins.list",
        "plugins.catalog.browse",
        "plugins.catalog.categories",
      ],
      methodResponses,
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/plugins/discover?query=calendar#featured`);
      await waitForControlUiRoute(page, { pathname: "/plugins", routeId: "plugins" });
      const location = new URL(page.url());
      expect(`${location.pathname}${location.search}${location.hash}`).toBe(
        "/plugins?query=calendar#featured",
      );
      await page.getByRole("searchbox", { name: "Search plugins", exact: true }).waitFor();
    } finally {
      await context.close();
    }
  });

  it.each([
    { label: "desktop", viewport: { height: 1053, width: 2048 } },
    { label: "laptop", viewport: { height: 928, width: 1200 } },
    { label: "tablet", viewport: { height: 1024, width: 768 } },
    { label: "narrow", viewport: { height: 852, width: 393 } },
  ])(
    "keeps the Plugins/Skills shell coherent through every $label transition",
    async ({ label, viewport }) => {
      const context = await createContext(viewport);
      const page = await context.newPage();
      await installMockGateway(page, {
        featureMethods: [
          "agents.list",
          "config.get",
          "plugins.list",
          "plugins.catalog.browse",
          "plugins.catalog.categories",
          "skills.proposals.historyStatus",
          "skills.proposals.list",
          "skills.status",
          "skills.search",
          "skills.library.list",
        ],
        methodResponses,
      });

      try {
        await page.goto(`${suite.server.baseUrl}plugins`);
        await page.addStyleTag({
          content:
            "*, *::before, *::after { animation-duration: 0s !important; transition-duration: 0s !important; }",
        });
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await waitForControlUiRoute(page, { pathname: "/plugins", routeId: "plugins" });
        await page.getByRole("searchbox", { name: "Search plugins", exact: true }).waitFor();
        const pluginsHeader = await headerGeometry(page);
        await captureScreenshot(page, `${label}-01-installed-plugins.png`);
        expect(pluginsHeader.title).toBe("Plugins");
        await expectHeaderCopy(page, "plugins");
        expect(await page.locator(".plugins-hub-tabs").getByRole("tab").count()).toBe(3);
        expect(
          await page.getByRole("tab", { name: "Plugins", exact: true }).getAttribute("active"),
        ).not.toBeNull();
        expect(await page.getByRole("tab", { name: /Installed|Discover/u }).count()).toBe(0);
        expect(await page.locator(".plugins-tabs").count()).toBe(1);
        expect(await page.locator(".plugins-tabs.oc-segmented").count()).toBe(0);
        const tabBox = await page.locator(".plugins-tabs").boundingBox();
        const pluginTabBox = await page
          .getByRole("tab", { name: "Plugins", exact: true })
          .boundingBox();
        expect(tabBox).not.toBeNull();
        expect(pluginTabBox).not.toBeNull();
        expect(pluginTabBox?.height ?? 0).toBeLessThanOrEqual(36);
        await expectActivePanelLabel(page, "plugins-tab-plugins");
        const pluginInstallPresentation = await installButtonPresentation(page);

        await page
          .locator(".plugins-hub-tabs")
          .getByRole("tab", { name: "Skills", exact: true })
          .click();
        await waitForControlUiRoute(page, { pathname: "/skills", routeId: "skills" });
        expectStableHeader(await headerGeometry(page), pluginsHeader);
        await expectHeaderCopy(page, "skills");
        await expectActivePanelLabel(page, "plugins-tab-skills");
        expect(await installButtonPresentation(page)).toEqual(pluginInstallPresentation);
        await captureScreenshot(page, `${label}-02-skills.png`);

        await page.getByRole("tab", { name: "Skill workshop", exact: true }).click();
        await waitForControlUiRoute(page, {
          pathname: "/skills/workshop",
          routeId: "skill-workshop",
        });
        expectStableHeader(await headerGeometry(page), pluginsHeader);
        await expectHeaderCopy(page, "skill-workshop");
        await expectActivePanelLabel(page, "plugins-tab-skill-workshop");
        expect(
          await page
            .getByRole("tab", { name: "Skill workshop", exact: true })
            .getAttribute("active"),
        ).not.toBeNull();
        await captureScreenshot(page, `${label}-03-workshop.png`);

        await page
          .locator(".plugins-hub-tabs")
          .getByRole("tab", { name: "Skills", exact: true })
          .click();
        await waitForControlUiRoute(page, { pathname: "/skills", routeId: "skills" });
        expectStableHeader(await headerGeometry(page), pluginsHeader);
        await expectHeaderCopy(page, "skills");
        await expectActivePanelLabel(page, "plugins-tab-skills");
        await page.getByRole("tab", { name: "Plugins", exact: true }).click();
        await waitForControlUiRoute(page, { pathname: "/plugins", routeId: "plugins" });
        expectStableHeader(await headerGeometry(page), pluginsHeader);
        await expectHeaderCopy(page, "plugins");
      } finally {
        await context.close();
      }
    },
  );
});
