// The Customize sidebar lists the plugins people added, newest install first.
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
  plugin({ id: "zulu", name: "Zulu", description: "Recovered install.", origin: "global" }),
  installed("linear", "Linear", "Plan work in Linear.", "2026-11-10T10:00:00Z"),
  {
    ...installed("lobster-theme", "Lobster Theme", "A warm red theme.", "2026-10-02T10:00:00Z"),
    hasIcon: true,
  },
  shopifyPlugin,
] satisfies PluginCatalogItem[];

function detail(entry: PluginCatalogItem): PluginDiscoveryDetailResult {
  return {
    plugin: {
      id: entry.catalogId!,
      catalog: { name: entry.name, summary: entry.description, official: false, categories: [] },
      local: {
        present: true,
        installed: true,
        enabled: entry.enabled,
        state: entry.state,
        pluginId: entry.id,
        action: "manage",
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

async function openShopify() {
  const setup = await setupPluginPage(
    {
      "plugins.list": inventory(plugins, 1),
      "plugins.inspect": {
        cases: plugins.map((entry) => ({
          match: { pluginId: entry.id },
          response: { ...calendarInspection, plugin: entry },
        })),
      },
      "plugins.catalog.get": {
        cases: plugins.map((entry) => ({
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
    { featureMethods: features },
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
  await setup.page.getByRole("heading", { name: "Shopify AI Toolkit", level: 1 }).waitFor();
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

  it("lists added plugins newest first, then opted-in bundled ones, across Customize pages", async () => {
    const { page } = await openShopify();
    const shopify = customize(page).getByRole("link", { name: "Shopify AI Toolkit", exact: true });
    await shopify.waitFor();
    await customize(page).locator(".sidebar-customize__plugin-icon img").nth(2).waitFor();
    // Disabled, systemic, and provider bundles stay on the Plugins page.
    expect(await pluginRows(page).allTextContents()).toEqual([
      "Shopify AI Toolkit",
      "Linear",
      "Lobster Theme",
      "Zulu",
      "Knowledge",
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

    // The list is fixed: other Customize pages keep the same shortcuts.
    await customize(page).getByRole("link", { name: "Skills", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/skills");
    const skills = customize(page).getByRole("link", { name: "Skills", exact: true });
    await expect.poll(() => skills.getAttribute("aria-current")).toBe("page");
    expect(await pluginRows(page).allTextContents()).toHaveLength(6);
    expect(await pluginsPage.getAttribute("aria-current")).toBeNull();
    await captureScreenshot(page, "after-skills.png", "viewport");
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
