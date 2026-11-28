import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PluginCatalogItem, PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import {
  calendarInspection,
  captureScreenshot,
  describeControlUiE2e,
  inventory,
  pluginMethods,
  server,
  setupPluginPage,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "./plugins.e2e.test-support.ts";

function catalogId(prefix: "ch_" | "local_", identity: string) {
  return prefix + Buffer.from(identity, "utf8").toString("base64url");
}

function plugin(
  entry: Pick<PluginCatalogItem, "id" | "name" | "description"> & Partial<PluginCatalogItem>,
): PluginCatalogItem {
  return {
    installed: true,
    enabled: true,
    state: "enabled",
    catalogId: catalogId(entry.clawhubPackage ? "ch_" : "local_", entry.clawhubPackage ?? entry.id),
    ...entry,
  };
}

const installed = (id: string, name: string, description: string, installedAt: string) =>
  plugin({
    id,
    name,
    description,
    clawhubPackage: "@acme/" + id,
    origin: "global",
    removable: true,
    installedAt: Date.parse(installedAt),
  });

const bundled = (id: string, name: string, description: string, sidebar?: boolean) =>
  plugin({ id, name, description, origin: "bundled", removable: false, sidebar });

const shopifyPlugin = installed(
  "shopify",
  "Shopify AI Toolkit",
  "Search Shopify docs and manage stores.",
  "2026-11-17T10:00:00Z",
);

const catalogOnlyPlugin = plugin({
  id: "firecrawl",
  name: "FireCrawl",
  description: "Web extraction and crawling.",
  clawhubPackage: "@openclaw/firecrawl",
  origin: "official",
  installed: false,
  enabled: false,
  state: "not-installed",
});

const plugins = [
  bundled("anthropic", "Anthropic", "Claude models."),
  bundled("memory-core", "OpenClaw Memory", "Default memory search."),
  bundled("clawrouter", "ClawRouter", "Route models through ClawRouter."),
  {
    ...bundled("workboard", "Workboard", "Dashboard workboard for agent-owned issues.", true),
    hasIcon: true,
  },
  { ...bundled("knowledge", "Knowledge", "Durable memory of your world.", true), hasIcon: true },
  { ...bundled("diffs", "Diffs", "Render diffs.", true), enabled: false, state: "disabled" },
  plugin({
    id: "zulu",
    name: "Zulu",
    description: "Recovered install.",
    origin: "global",
    catalogId: undefined,
  }),
  installed("linear", "Linear", "Plan work in Linear.", "2026-11-10T10:00:00Z"),
  {
    ...installed("lobster-theme", "Lobster Theme", "A warm red theme.", "2026-10-02T10:00:00Z"),
    hasIcon: true,
  },
  shopifyPlugin,
  catalogOnlyPlugin,
] satisfies PluginCatalogItem[];

const longPlugins = [
  shopifyPlugin,
  installed("linear", "Linear", "Plan work in Linear.", "2026-11-16T10:00:00Z"),
  installed("sentry", "Sentry", "Track runtime errors.", "2026-11-15T10:00:00Z"),
  installed("figma", "Figma", "Inspect design specs.", "2026-11-14T10:00:00Z"),
  installed("notion", "Notion", "Search workspace notes.", "2026-11-13T10:00:00Z"),
  installed("stripe", "Stripe", "Inspect billing events.", "2026-11-12T10:00:00Z"),
  installed("vercel", "Vercel", "Check deployments.", "2026-11-11T10:00:00Z"),
  {
    ...installed("lobster-theme", "Lobster Theme", "A warm red theme.", "2026-11-10T10:00:00Z"),
    hasIcon: true,
  },
  installed(
    "lossless-claw",
    "Lossless Claw",
    "Lossless conversation recall.",
    "2026-11-09T10:00:00Z",
  ),
  bundled("anthropic", "Anthropic", "Claude models."),
  { ...bundled("diffs", "Diffs", "Render diffs.", true), enabled: false, state: "disabled" },
  { ...bundled("knowledge", "Knowledge", "Durable memory of your world.", true), hasIcon: true },
  {
    ...bundled("workboard", "Workboard", "Dashboard workboard for agent-owned issues.", true),
    hasIcon: true,
  },
  catalogOnlyPlugin,
] satisfies PluginCatalogItem[];

const shortViewport = { width: 1280, height: 480 };

function detail(entry: PluginCatalogItem): PluginDiscoveryDetailResult {
  return {
    plugin: {
      id: entry.catalogId!,
      catalog: { name: entry.name, summary: entry.description, official: false, categories: [] },
      local: {
        present: entry.installed,
        installed: entry.installed,
        enabled: entry.enabled,
        state: entry.state,
        pluginId: entry.id,
        action: entry.installed ? "manage" : "install",
      },
    },
    detail: {
      origin: "local",
      topics: [],
      configuration: [],
      mcpServers: [],
      skills: [],
      versions: [],
    },
  };
}

const features = [...pluginMethods, "skills.status"];

async function openShopify(
  entries: PluginCatalogItem[] = plugins,
  options: {
    viewport?: { width: number; height: number };
    methodDelays?: Record<string, number | "forever">;
  } = {},
) {
  const setup = await setupPluginPage(
    {
      "plugins.list": inventory(entries, 1),
      "plugins.inspect": {
        cases: entries.map((entry) => ({
          match: { pluginId: entry.id },
          response: { ...calendarInspection, plugin: entry },
        })),
      },
      "plugins.catalog.get": {
        cases: entries
          .filter((entry) => entry.catalogId)
          .map((entry) => ({
            match: { id: entry.catalogId },
            response: detail(entry),
          })),
      },
      "skills.status": {
        workspaceDir: "/tmp/openclaw-e2e/workspace",
        managedSkillsDir: "/tmp/openclaw-e2e/skills",
        skills: [],
      },
    },
    { featureMethods: features, methodDelays: options.methodDelays },
    options.viewport,
  );
  await setup.page.addInitScript(
    ({ gatewayUrl }) => {
      window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl };
    },
    { gatewayUrl: server.baseUrl.replace(/^http/u, "ws") },
  );
  // Serve packaged artwork; plugins without an icon keep their initial.
  const artwork: Record<string, string> = {
    shopify: "lobster",
    workboard: "workboard",
    knowledge: "knowledge",
    "lobster-theme": "lobster",
  };
  await setup.page.route("**/__openclaw__/plugin-icon/**", async (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? "");
    const owner = artwork[id];
    await (owner
      ? route.fulfill({
          contentType: "image/png",
          body: await readFile(path.resolve("extensions", owner, "assets/icon.png")),
        })
      : route.fulfill({ status: 404 }));
  });
  await setup.page.goto(server.baseUrl + "plugins/acme/shopify");
  return setup;
}

function customize(page: Page) {
  return page.locator("openclaw-app-sidebar .sidebar-customize");
}

const pluginRows = (page: Page) =>
  customize(page).locator(".sidebar-customize__plugins .nav-item__text");

describeControlUiE2e("Customize sidebar plugins", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("lists every installed plugin in order, excludes catalog-only items, and keeps selection across Customize pages", async () => {
    const { page } = await openShopify();
    const shopify = customize(page).getByRole("link", { name: "Shopify AI Toolkit", exact: true });
    await shopify.waitFor();
    await customize(page).locator(".sidebar-customize__plugin-icon img").nth(2).waitFor();
    expect(await pluginRows(page).allTextContents()).toEqual([
      "Shopify AI Toolkit",
      "Linear",
      "Lobster Theme",
      "Zulu",
      "Anthropic",
      "ClawRouter",
      "Diffs",
      "Knowledge",
      "OpenClaw Memory",
      "Workboard",
    ]);
    expect(await shopify.getAttribute("aria-current")).toBe("page");
    const pluginsPage = customize(page).getByRole("link", { name: "Plugins", exact: true });
    expect(await pluginsPage.getAttribute("aria-current")).toBeNull();
    await captureScreenshot(page, "after-plugin-detail.png", "viewport");

    await customize(page).getByRole("link", { name: "Knowledge", exact: true }).click();
    await page.getByRole("heading", { name: "Knowledge", level: 1 }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/plugins/" + catalogId("local_", "knowledge"));
    expect(
      await customize(page)
        .getByRole("link", { name: "Knowledge", exact: true })
        .getAttribute("aria-current"),
    ).toBe("page");

    await customize(page).getByRole("link", { name: "Skills", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/skills");
    const skills = customize(page).getByRole("link", { name: "Skills", exact: true });
    await expect.poll(() => skills.getAttribute("aria-current")).toBe("page");
    expect(await pluginRows(page).allTextContents()).toHaveLength(10);
    expect(await pluginsPage.getAttribute("aria-current")).toBeNull();
    await captureScreenshot(page, "after-skills.png", "viewport");

    const local = customize(page).getByRole("link", { name: "Zulu", exact: true });
    expect(await local.getAttribute("href")).toBe("/settings/plugins/zulu");
    await local.click();
    await page.waitForURL((url) => url.pathname === "/settings/plugins/zulu");
    await page.getByRole("heading", { name: "Zulu", level: 1 }).waitFor();
  });

  it("remeasures deferred rows and keeps the ninth and final plugins reachable in a short window", async () => {
    const { page, gateway } = await openShopify(longPlugins, {
      viewport: shortViewport,
      methodDelays: { "plugins.list": "forever" },
    });
    const sidebar = page.locator("openclaw-app-sidebar");
    const body = sidebar.locator(".sidebar-shell__body");
    const header = sidebar.locator(".sidebar-panel-header");
    const rail = sidebar.locator(".sidebar-rail");
    const link = (name: string) => customize(page).getByRole("link", { name, exact: true });
    const ninth = link("Lossless Claw");
    const last = link("Workboard");
    await link("Skills").waitFor();
    await gateway.waitForRequest("plugins.list");
    expect(await pluginRows(page).count()).toBe(0);
    expect(await body.getAttribute("class")).toContain("sidebar-shell__body--scroll-none");
    const headerBefore = await header.boundingBox();
    const railBefore = await rail.boundingBox();

    await gateway.setMethodDelay("plugins.list", null);
    await last.waitFor();
    expect(await pluginRows(page).count()).toBe(13);
    expect(await pluginRows(page).nth(8).textContent()).toBe("Lossless Claw");
    expect(await pluginRows(page).last().textContent()).toBe("Workboard");
    expect(await body.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
    await expect
      .poll(() => body.getAttribute("class"))
      .toContain("sidebar-shell__body--scroll-top");

    await ninth.click();
    await page.getByRole("heading", { name: "Lossless Claw", level: 1 }).waitFor();
    expect(await ninth.getAttribute("aria-current")).toBe("page");
    expect(await link("Plugins").getAttribute("aria-current")).toBeNull();
    await last.scrollIntoViewIfNeeded();
    await expect
      .poll(() => body.getAttribute("class"))
      .toContain("sidebar-shell__body--scroll-bottom");
    expect(await header.boundingBox()).toEqual(headerBefore);
    expect(await rail.boundingBox()).toEqual(railBefore);
    await header.getByRole("button").click({ trial: true });
    await rail.locator('[data-navigation-view="sessions"]').click({ trial: true });
    await page.mouse.move(1220, 445);
    await captureScreenshot(page, "long-inventory.png", "viewport");

    // Start on a different route so Enter must navigate, not just retain selection.
    await link("Shopify AI Toolkit").click();
    await page.getByRole("heading", { name: "Shopify AI Toolkit", level: 1 }).waitFor();
    await link("Shopify AI Toolkit").focus();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
    }
    expect(await ninth.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Lossless Claw", level: 1 }).waitFor();
    expect(await ninth.getAttribute("aria-current")).toBe("page");
    await ninth.focus();
    await page.keyboard.press("Shift+Tab");
    expect(await link("Lobster Theme").evaluate((el) => el === document.activeElement)).toBe(true);
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("Tab");
    }
    expect(await last.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Workboard", level: 1 }).waitFor();
    expect(await last.getAttribute("aria-current")).toBe("page");
  });

  it("does not add unnecessary vertical scroll for a short installed list", async () => {
    const shortPlugins = plugins.filter((entry) =>
      ["shopify", "linear", "knowledge", "firecrawl"].includes(entry.id),
    );
    const { page } = await openShopify(shortPlugins, { viewport: shortViewport });
    await customize(page).getByRole("link", { name: "Knowledge", exact: true }).waitFor();
    expect(await pluginRows(page).allTextContents()).toEqual([
      "Shopify AI Toolkit",
      "Linear",
      "Knowledge",
    ]);
    const body = page.locator("openclaw-app-sidebar .sidebar-shell__body");
    await expect
      .poll(() => body.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeLessThanOrEqual(0);
    await expect
      .poll(() =>
        body.evaluate((element) => element.classList.contains("sidebar-shell__body--scroll-none")),
      )
      .toBe(true);
  });

  it("loads newly available artwork for a retained shortcut after a plugin update", async () => {
    const { page, gateway } = await openShopify();
    const shortcut = customize(page).getByRole("link", { name: "Shopify AI Toolkit", exact: true });
    await shortcut.waitFor();
    const unchanged = customize(page)
      .getByRole("link", { name: "Knowledge", exact: true })
      .locator("img");
    await unchanged.waitFor({ state: "visible" });
    const original = await unchanged.elementHandle();

    const shopifyWithArtwork = { ...shopifyPlugin, hasIcon: true };
    await gateway.setMethodResponse(
      "plugins.list",
      inventory(
        plugins.map((entry) => (entry.id === shopifyPlugin.id ? shopifyWithArtwork : entry)),
        2,
      ),
    );
    await gateway.setMethodResponse("plugins.uiDescriptors", {
      generation: 2,
      methods: features,
      controlUiTabs: [],
      controlUiWidgetKinds: [],
      controlUiLinkReaders: [],
      pluginSurfaceUrls: {},
    });
    await gateway.emitGatewayEvent("plugins.changed", { generation: 2 });
    await shortcut.locator("img").waitFor({ state: "visible", timeout: 5_000 });
    // Shopify gained art, but Knowledge must never return to its loading tile.
    expect(await unchanged.evaluate((image, previous) => image === previous, original)).toBe(true);
  });
});
