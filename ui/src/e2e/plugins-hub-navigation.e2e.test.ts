import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type {
  PluginDiscoveryEntry,
  PluginsCatalogBrowseResult,
  PluginsListResult,
} from "../../../packages/gateway-protocol/src/schema/plugins.js";
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
  "skills.workshop.list": {
    agentId: "main",
    mode: "auto",
    root: "/tmp/openclaw-e2e/agents/main/workshop-skills",
    skills: [],
    archived: [],
  },
  "skills.workshop.changes": { changes: [] },
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
      subtitle: "Add capabilities with plugins.",
      docs: "https://docs.openclaw.ai/plugins/manage-plugins",
    },
    skills: {
      title: "Skills",
      subtitle: "Manage your agent skills",
      docs: "https://docs.openclaw.ai/tools/skills",
    },
    "skill-workshop": {
      title: "Skill workshop",
      subtitle: "Drafts, recent changes, and skills your agent learned.",
      docs: "https://docs.openclaw.ai/tools/skill-workshop",
    },
  }[active];
  const header = page.locator(".plugins-hub-header");
  expect(await header.getByRole("heading", { level: 1 }).textContent()).toBe(expected.title);
  // The phone's floating header carries the title, leaving it for assistive tech.
  const floatingHeader = (await page.locator(".shell--floating-header").count()) > 0;
  if (floatingHeader) {
    const title = page.locator(".topbar-page-title");
    await title.waitFor();
    // Plugins is the landing page for the Customize section.
    expect(await title.textContent()).toBe(active === "plugins" ? "Customize" : expected.title);
  }
  const compactWorkshop =
    active === "skill-workshop" &&
    (await page.evaluate(
      () =>
        matchMedia(
          "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
        ).matches,
    ));
  expect(await header.locator(".page-subtitle").textContent()).toContain(expected.subtitle);
  if (compactWorkshop) {
    // The compact title is visually clipped, not removed from the accessibility tree.
    expect(
      await header
        .locator(".hub-page-header__title")
        .evaluate((el) => getComputedStyle(el).clipPath),
    ).toBe("inset(50%)");
    // The learning state replaces the subtitle; its gear contains the docs link.
    await header.getByText("Learning from work, saves on its own", { exact: true }).waitFor();
    const mode = "Skill Workshop learning mode";
    await header.getByRole("button", { name: mode, exact: true }).click();
    const menu = page.getByRole("dialog", { name: mode, exact: true });
    expect(await menu.getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe(
      expected.docs,
    );
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
  } else {
    await expect
      .poll(() =>
        header.evaluate((element) => {
          const title = element.querySelector(".page-title")?.getBoundingClientRect();
          return title ? title.width > 1 && title.height > 1 : null;
        }),
      )
      .toBe(!floatingHeader);
    expect(await header.getByRole("link", { name: "Learn more" }).getAttribute("href")).toBe(
      expected.docs,
    );
  }
}

async function installButtonPresentation(button: Locator) {
  await button.waitFor({ state: "visible" });
  await expect.poll(() => button.isEnabled()).toBe(true);
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
      page.locator(".plugins-hub-header"),
    ]),
  );
}

// The Customize sidebar lists the hub's pages; a mobile layout keeps it in the drawer.
function customizeSidebar(page: Page, mobile: boolean) {
  const sidebar = page.locator("openclaw-app-sidebar .sidebar-customize");
  const expand = () =>
    mobile
      ? page.getByRole("button", { name: "Expand sidebar", exact: true }).click()
      : Promise.resolve();
  return {
    sidebar,
    row: (name: string) => sidebar.getByRole("link", { name, exact: true }),
    // Choosing Customize from the page menu selects its sidebar.
    select: async () => {
      await expand();
      await page.locator("openclaw-app-sidebar [data-rail-more]").click();
      await page
        .locator(".sidebar-pages-menu")
        .getByRole("link", { name: "Customize", exact: true })
        .click();
    },
    open: async (name: string) => {
      await expand();
      await sidebar.getByRole("link", { name, exact: true }).click();
    },
  };
}

suite.define(() => {
  it("keeps model-provider video capabilities discoverable in Media across pagination", async () => {
    const context = await createContext({ width: 1200, height: 928 });
    const page = await context.newPage();
    const local: PluginsListResult = {
      plugins: [
        { id: "novita", name: "Novita", installed: false },
        { id: "zai", name: "Z.AI", installed: false },
        { id: "studio-video", name: "Studio Video", installed: true },
      ].map(({ id, name, installed }) => ({
        id,
        name,
        packageName: "@openclaw/" + id,
        clawhubPackage: "@openclaw/" + id,
        installed,
        enabled: installed,
        state: installed ? "enabled" : "not-installed",
        description: "Model inference and video generation.",
        categories: ["models"],
        capabilityCategories: ["media"],
      })),
      diagnostics: [],
      mutationAllowed: true,
    };
    expect(local.plugins.map((plugin) => plugin.categories)).toEqual([
      ["models"],
      ["models"],
      ["models"],
    ]);
    expect(local.plugins.map((plugin) => plugin.capabilityCategories)).toEqual([
      ["media"],
      ["media"],
      ["media"],
    ]);
    // Gateway wire fixtures; the catalog owners test category derivation and joining.
    const novita = {
      id: "ch_QG9wZW5jbGF3L25vdml0YQ",
      catalog: {
        name: "Novita",
        packageName: "@openclaw/novita",
        summary: "Model inference and video generation.",
        official: true,
        author: "openclaw",
        categories: ["models", "media"],
        publishedToClawHub: true,
      },
      local: {
        present: true,
        installed: false,
        enabled: false,
        state: "not-installed",
        pluginId: "novita",
        action: "install",
      },
    } satisfies PluginDiscoveryEntry;
    const zai = {
      id: "ch_QG9wZW5jbGF3L3phaQ",
      catalog: { ...novita.catalog, name: "Z.AI", packageName: "@openclaw/zai" },
      local: { ...novita.local, pluginId: "zai" },
    } satisfies PluginDiscoveryEntry;
    const installedVideo = {
      id: "ch_QG9wZW5jbGF3L3N0dWRpby12aWRlbw",
      catalog: { ...novita.catalog, name: "Studio Video", packageName: "@openclaw/studio-video" },
      local: {
        present: true,
        installed: true,
        enabled: true,
        state: "enabled",
        pluginId: "studio-video",
        action: "manage",
      },
    } satisfies PluginDiscoveryEntry;
    const fal = {
      id: "ch_QG9wZW5jbGF3L2ZhbA",
      catalog: {
        name: "fal",
        packageName: "@openclaw/fal",
        summary: "Image, video, and music generation.",
        family: "code-plugin",
        official: true,
        categories: ["media"],
        downloads: 1000,
        publishedToClawHub: true,
      },
      local: {
        present: false,
        installed: false,
        enabled: false,
        state: "not-installed",
        action: "install",
      },
    } satisfies PluginDiscoveryEntry;
    const publishedNovita = {
      id: novita.id,
      catalog: {
        ...fal.catalog,
        name: "Novita",
        packageName: "@openclaw/novita",
        categories: ["models", "media"],
      },
      local: novita.local,
    } satisfies PluginDiscoveryEntry;
    // The baseline exposed purpose metadata but no derived Media membership.
    const beforeNovita = { ...novita, catalog: { ...novita.catalog, categories: ["models"] } };
    const beforeZai = { ...zai, catalog: { ...zai.catalog, categories: ["models"] } };
    const catalogPages = {
      beforeModels: { items: [beforeNovita, beforeZai] },
      beforeMedia: { items: [fal], nextCursor: "media-page-two" },
      all: {
        items: [fal, novita, zai, installedVideo],
        categories: discoveryCategories.categories,
      },
      models: { items: [novita, zai, installedVideo] },
      media: { items: [fal, novita, zai, installedVideo], nextCursor: "media-page-two" },
      nextMedia: {
        items: [
          publishedNovita,
          installedVideo,
          {
            ...fal,
            id: "ch_bW90aW9u",
            catalog: { ...fal.catalog, name: "Motion", packageName: "motion" },
          },
        ],
      },
    } satisfies Record<string, PluginsCatalogBrowseResult>;
    const gateway = await installMockGateway(page, {
      featureMethods: ["plugins.list", "plugins.catalog.browse", "plugins.catalog.categories"],
      methodResponses: {
        ...methodResponses,
        "plugins.list": local,
        "plugins.catalog.browse": catalogPages.all,
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
      await expect
        .poll(() => page.locator('[data-catalog-section="models"] .plugin-catalog-card').count())
        .toBe(2);
      await expect
        .poll(() => page.locator('[data-catalog-section="media"] .plugin-catalog-card').count())
        .toBe(3);
      if (captureUiProof) {
        // Keep the current overview cached; only the filtered responses model the old taxonomy.
        await gateway.setMethodResponse("plugins.catalog.browse", catalogPages.beforeModels);
        await chips.getByRole("button", { name: "Models", exact: true }).click();
        await gateway.waitForRequest("plugins.catalog.browse", { match: { category: "models" } });
        await expectFilteredCards("Models", ["Novita", "Z.AI"]);
        await captureScreenshot(page, "models-discovery-before.png");
        await gateway.setMethodResponse("plugins.catalog.browse", catalogPages.beforeMedia);
        await chips.getByRole("button", { name: "Media", exact: true }).click();
        await gateway.waitForRequest("plugins.catalog.browse", { match: { category: "media" } });
        await expectFilteredCards("Media", ["fal"]);
        await captureScreenshot(page, "media-discovery-before.png");
        await chips.getByRole("button", { name: "All", exact: true }).click();
      }
      const priorModels = (
        await gateway.getRequests("plugins.catalog.browse", { category: "models" })
      ).length;
      await gateway.setMethodResponse("plugins.catalog.browse", catalogPages.models);
      await chips.getByRole("button", { name: "Models", exact: true }).click();
      await gateway.waitForRequest("plugins.catalog.browse", {
        after: priorModels,
        match: { category: "models" },
      });
      await expectFilteredCards("Models", ["Novita", "Z.AI"]);
      await captureScreenshot(page, "models-discovery-after.png");
      const priorMedia = (
        await gateway.getRequests("plugins.catalog.browse", { category: "media" })
      ).length;
      await gateway.setMethodResponse("plugins.catalog.browse", catalogPages.media);
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
      // Installed providers belong in search, not in ordinary browsing or its later pages.
      const search = page.getByRole("searchbox", { name: "Search plugins", exact: true });
      await search.fill("video");
      await gateway.waitForRequest("plugins.catalog.browse", {
        match: { intent: "all", query: "video", searchSource: "openclaw-control-ui" },
      });
      await expectFilteredCards("All", ["fal", "Novita", "Studio Video", "Z.AI"]);
      await chips.getByRole("button", { name: "Media", exact: true }).click();
      await gateway.waitForRequest("plugins.catalog.browse", {
        match: { category: "media", query: "video" },
      });
      await expectFilteredCards("Media", ["fal", "Novita", "Studio Video", "Z.AI"]);
      const priorBrowse = (
        await gateway.getRequests("plugins.catalog.browse", { category: "media" })
      ).length;
      await search.fill("");
      await gateway.waitForRequest("plugins.catalog.browse", {
        after: priorBrowse,
        match: { category: "media" },
      });
      await expectFilteredCards("Media", ["fal", "Novita", "Z.AI"]);
      await gateway.setMethodResponse("plugins.catalog.browse", catalogPages.nextMedia);
      await page.getByRole("button", { name: "Load more", exact: true }).click();
      await gateway.waitForRequest("plugins.catalog.browse", {
        match: { category: "media", cursor: "media-page-two" },
      });
      await expect
        .poll(() => page.getByRole("button", { name: "Load more", exact: true }).count())
        .toBe(0);
      await expectFilteredCards("Media", ["fal", "Motion", "Novita", "Z.AI"]);
      expect(await cards.count()).toBe(4);
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
          "skills.workshop.changes",
          "skills.workshop.list",
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
        // The Customize sidebar replaces the hub's tabs.
        expect(await page.getByRole("tab").count()).toBe(0);
        const pluginInstallPresentation = await installButtonPresentation(
          page
            .locator('[data-catalog-section="featured"]')
            .getByRole("button", { name: "Install Matrix", exact: true }),
        );
        const mobile = viewport.width <= 900;
        const customize = customizeSidebar(page, mobile);

        await customize.open("Skills");
        await waitForControlUiRoute(page, { pathname: "/skills", routeId: "skills" });
        expectStableHeader(await headerGeometry(page), pluginsHeader);
        await expectHeaderCopy(page, "skills");
        const addCalendar = page.getByRole("button", { name: "Add Calendar", exact: true });
        expect(await installButtonPresentation(addCalendar)).toEqual(pluginInstallPresentation);
        await captureScreenshot(page, `${label}-02-skills.png`);

        await customize.open("Skill workshop");
        await waitForControlUiRoute(page, {
          pathname: "/skills/workshop",
          routeId: "skill-workshop",
        });
        expectStableHeader(await headerGeometry(page), pluginsHeader);
        await captureScreenshot(page, `${label}-03-workshop.png`);
        await expectHeaderCopy(page, "skill-workshop");
        if (!mobile) {
          expect(await customize.row("Skill workshop").getAttribute("aria-current")).toBe("page");
        }

        await customize.open("Skills");
        await waitForControlUiRoute(page, { pathname: "/skills", routeId: "skills" });
        expectStableHeader(await headerGeometry(page), pluginsHeader);
        await expectHeaderCopy(page, "skills");
        await customize.open("Plugins");
        await waitForControlUiRoute(page, { pathname: "/plugins", routeId: "plugins" });
        expectStableHeader(await headerGeometry(page), pluginsHeader);
        await expectHeaderCopy(page, "plugins");
      } finally {
        await context.close();
      }
    },
  );
  it("lists the Customize pages in its sidebar", async () => {
    const context = await createContext({ width: 1280, height: 800 });
    const page = await context.newPage();
    const config = { gateway: { controlUi: { experimental: { templates: true } } } };
    await installMockGateway(page, {
      featureMethods: ["config.get", "plugins.list", "plugins.catalog.browse"],
      methodResponses: {
        ...methodResponses,
        "config.get": {
          ...methodResponses["config.get"],
          config,
          sourceConfig: config,
          raw: JSON.stringify(config),
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await waitForControlUiRoute(page, { routeId: "chat" });
      const customize = customizeSidebar(page, false);
      await customize.select();
      await waitForControlUiRoute(page, { pathname: "/plugins", routeId: "plugins" });
      await customize.row("Templates").waitFor();
      expect(
        await customize.sidebar
          .locator(":scope > .nav-item")
          .evaluateAll((rows) => rows.map((row) => row.textContent)),
      ).toEqual(["Plugins", "Skills", "Skill workshop", "Templates"]);
      expect(await customize.row("Plugins").getAttribute("aria-current")).toBe("page");
      // Templates follows its experimental flag; selection follows the open page.
      await customize.open("Templates");
      await waitForControlUiRoute(page, { pathname: "/templates", routeId: "templates" });
      expect(await customize.row("Templates").getAttribute("aria-current")).toBe("page");
      expect(await customize.row("Plugins").getAttribute("aria-current")).toBeNull();
    } finally {
      await context.close();
    }
  });
  it.each([
    {
      locale: "en",
      direction: "ltr",
      wheel: 1,
      initial: ["true", "false"],
      final: ["false", "true"],
    },
    {
      locale: "ar",
      direction: "rtl",
      wheel: -1,
      initial: ["false", "true"],
      final: ["true", "false"],
    },
  ])(
    "reports physical discovery scroll edges in $direction",
    async ({ locale, direction, wheel, initial, final }) => {
      const context = await createContext({ width: 390, height: 844 });
      const page = await context.newPage();
      try {
        const config = { ui: { prefs: { locale } } };
        const profileId = "scroll-operator";
        await installMockGateway(page, {
          authMethod: "trusted-proxy",
          authMode: "trusted-proxy",
          presenceUsers: [{ id: profileId, self: true }],
          bootstrapPreferences: { profileId, config, entries: {} },
          featureMethods: [
            "plugins.list",
            "plugins.catalog.browse",
            "plugins.catalog.categories",
            "config.get",
          ],
          methodResponses: {
            ...methodResponses,
            "config.get": {
              ...methodResponses["config.get"],
              config,
              sourceConfig: config,
              runtimeConfig: config,
            },
          },
        });
        await page.goto(suite.server.baseUrl + "plugins");
        await expect.poll(() => page.locator("html").getAttribute("dir")).toBe(direction);
        const chips = page.locator(".plugin-catalog-chips");
        // The loading skeleton also overflows; exercise the actual category strip.
        await chips.getByRole("button", { name: "Channels", exact: true }).waitFor();
        await expect
          .poll(() => chips.evaluate((element) => element.scrollWidth - element.clientWidth))
          .toBeGreaterThan(4);
        const edges = () =>
          chips.evaluate((element: HTMLElement) => [
            element.dataset.atStart,
            element.dataset.atEnd,
          ]);
        await captureScreenshot(page, `scroll-edges-${direction}.png`);
        await expect.poll(edges).toEqual(initial);
        await chips.hover();
        const distance = await chips.evaluate(
          (element) => element.scrollWidth - element.clientWidth,
        );
        await page.mouse.wheel((wheel * distance) / 2, 0);
        await expect.poll(edges).toEqual(["false", "false"]);
        await page.mouse.wheel(wheel * distance, 0);
        await expect.poll(edges).toEqual(final);
      } finally {
        await context.close();
      }
    },
  );
});
