import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  takeControlUiScreenshotFrame,
  waitForControlUiFrameLayout,
  waitForControlUiProofSurface,
} from "../../test-helpers/control-ui-e2e-screenshot.ts";
import { pauseVirtualClock, reconnectMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import { observeLayoutShifts } from "../../test-helpers/control-ui-layout-shift.ts";
import {
  captureScreenshot,
  calendarInspection,
  describeControlUiE2e,
  discoveryResult,
  initialInventory,
  installMockGateway,
  inventory,
  localCalendarDisabled,
  localOnlyDiscoveryPlugin,
  matrixConfigSchema,
  matrixDetail,
  matrixDiscoveryPlugin,
  matrixEnabled,
  matrixNeedsSetup,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  readOnlyConnectResponse,
  server,
  setupPluginPage as setup,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "./plugins.e2e.test-support.ts";

function role(root: Page | Locator, kind: Parameters<Page["getByRole"]>[0], name: string) {
  return root.getByRole(kind, { name, exact: true });
}

function text(root: Page | Locator, value: string) {
  return root.getByText(value, { exact: true });
}

const renamedPlugin = (plugin: (typeof discoveryResult.items)[number], name: string) => ({
  ...plugin,
  catalog: { ...plugin.catalog, name },
});

async function expectBrowse(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  params: Record<string, unknown>,
) {
  const request = await gateway.waitForRequest("plugins.catalog.browse", {
    after: 0,
    match: params,
  });
  expect(request.params).toEqual(params);
}

function setInstalled(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  plugin: Parameters<typeof inventory>[0][number],
) {
  return gateway.setMethodResponse(
    "plugins.list",
    inventory([...initialInventory.plugins, plugin]),
  );
}

describeControlUiE2e("Control UI Plugins mocked Gateway E2E", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("keeps known catalog identity visible while details load, fail, and retry", async () => {
    const name = "Shopify AI Toolkit";
    const summary = "Search Shopify developer docs, explore APIs, and build storefronts.";
    const id = "ch_" + Buffer.from("@shopify/ai-toolkit").toString("base64url");
    const plugin = {
      ...matrixDiscoveryPlugin,
      id,
      catalog: {
        ...matrixDiscoveryPlugin.catalog,
        name,
        summary,
        author: "shopify",
        imageUrl: "https://example.test/shopify-toolkit.svg",
      },
    };
    const result = {
      plugin,
      detail: {
        origin: "clawhub",
        packageName: "@shopify/ai-toolkit",
        author: { handle: "shopify", displayName: "Shopify", official: true },
        topics: [],
        configuration: [],
        mcpServers: [],
        versions: [],
        skills: [{ name: "Shopify developer docs" }],
        readme: "# Build with Shopify\n\nUse Shopify developer tools from OpenClaw.",
      },
    };
    const { page, gateway } = await setup({
      "plugins.catalog.browse": {
        cases: [
          { match: { query: "shopify" }, response: { items: [plugin] } },
          { match: { intent: "all", pageSize: 100 }, response: discoveryResult },
        ],
      },
    });
    await page.emulateMedia({ colorScheme: "dark" });
    let iconRequests = 0;
    await page.route("**/__openclaw__/catalog-icon/**", async (route) => {
      if (!decodeURIComponent(route.request().url()).endsWith("/shopify-toolkit.svg")) {
        await route.abort();
        return;
      }
      iconRequests++;
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path fill="#95bf47" d="M15 22h34l5 32H10z"/><path fill="none" stroke="#537826" stroke-width="4" d="M24 25v-9a8 8 0 0 1 16 0v9"/><path fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" d="M37 32c-3-3-10-3-10 3 0 4 10 3 10 8 0 5-6 6-12 3"/></svg>',
      });
    });
    await page.goto(server.baseUrl + "plugins");
    await role(page, "searchbox", "Search plugins").fill("shopify");
    const row = page.locator('[data-plugin-id="' + id + '"]');
    await role(row, "link", name).waitFor();
    await expect
      .poll(() => row.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);

    const before = await gateway.deferNext("plugins.catalog.get", { id });
    await role(row, "link", name).click();
    await gateway.waitForRequest("plugins.catalog.get", { after: before, match: { id } });
    await page.mouse.move(2, 2);
    const detail = page.locator(".plugin-catalog-detail");
    const heading = detail.getByRole("heading", { name, level: 1 });
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      const dir = createControlUiE2eArtifactDir("catalog-detail-pending");
      const frame = await takeControlUiScreenshotFrame(
        page,
        detail,
        [detail.locator(".plugin-catalog-detail__hero")],
        { animations: "disabled" },
      );
      await writeFile(path.join(dir, "catalog-detail-pending.png"), frame.png);
    }
    await heading.waitFor({ timeout: 2_000 });
    const headingNode = await heading.elementHandle();
    const icon = detail.locator(".plugin-catalog-detail__icon img");
    const iconSrc = await icon.getAttribute("src");
    expect(iconSrc).toMatch(/^blob:/u);
    expect(await role(detail, "navigation", "Breadcrumb").getByText(name).count()).toBe(1);
    expect(await text(detail, summary).count()).toBe(1);
    expect(await role(detail, "link", "@shopify").count()).toBe(1);
    expect(await detail.locator(".plugin-official-badge").count()).toBe(1);
    expect(await detail.locator(".plugin-metadata__loading").count()).toBe(1);
    expect(await role(detail, "button", "Install").count()).toBe(0);

    await gateway.rejectDeferred("plugins.catalog.get", {
      code: "UNAVAILABLE",
      message: "Catalog details temporarily unavailable",
    });
    const error = detail.getByRole("alert");
    await text(error, "Catalog details temporarily unavailable").waitFor();
    expect(await heading.isVisible()).toBe(true);
    expect(await detail.locator(".plugin-metadata__loading").count()).toBe(0);

    const retry = await gateway.deferNext("plugins.catalog.get", { id });
    await role(error, "button", "Try again").click();
    await gateway.waitForRequest("plugins.catalog.get", { after: retry, match: { id } });
    await detail.locator(".plugin-metadata__loading").waitFor();
    expect(await heading.isVisible()).toBe(true);
    await gateway.resolveDeferred("plugins.catalog.get", result);
    await detail.getByRole("heading", { name: "Build with Shopify" }).waitFor();
    await role(detail, "button", "Install").waitFor();
    expect(await text(detail, "Shopify").count()).toBe(1);
    expect(await heading.evaluate((node, previous) => node === previous, headingNode)).toBe(true);
    expect(await icon.getAttribute("src")).toBe(iconSrc);
    expect(iconRequests).toBe(1);

    await role(detail, "link", "Plugins").click();
    expect(await role(page, "searchbox", "Search plugins").inputValue()).toBe("shopify");
    await role(row, "link", name).waitFor();
  });

  it("does not reuse another plugin's identity on a fast catalog switch or cold deep link", async () => {
    const method = "plugins.catalog.get";
    const first = { id: matrixDiscoveryPlugin.id };
    const second = { id: localOnlyDiscoveryPlugin.id };
    const { page, gateway } = await setup({}, { heldMethods: [method] });
    const detail = page.locator(".plugin-catalog-detail");
    const matrix = detail.getByRole("heading", { name: "Matrix", level: 1 });
    const calendar = detail.getByRole("heading", { name: "Local Calendar", level: 1 });

    await page.goto(server.baseUrl + "plugins");
    const firstRow = page.locator('[data-plugin-id="' + first.id + '"]').first();
    await role(firstRow, "link", "Matrix").click();
    await gateway.waitForRequest(method, { match: first });
    await matrix.waitFor();
    expect(await detail.locator(".plugins-tile--neutral").count()).toBe(1);
    await role(detail, "link", "Plugins").click();
    await role(page, "link", "Local Calendar").first().click();
    await gateway.waitForRequest(method, { match: second });
    await calendar.waitFor();

    await gateway.resolveDeferred(method, matrixDetail, { match: first });
    expect(await calendar.isVisible()).toBe(true);
    expect(await detail.locator(".plugin-metadata__loading").isVisible()).toBe(true);
    expect(await matrix.count()).toBe(0);
    await gateway.resolveDeferred(method, undefined, { match: second });
    await text(detail.locator(".plugin-capabilities"), "Calendar planning").waitFor();
    expect(await matrix.count()).toBe(0);
    expect(
      await detail.getByText("Connect OpenClaw to Matrix rooms and direct messages.").count(),
    ).toBe(0);

    await page.reload();
    await gateway.waitForRequest(method, { match: second });
    await page.locator(".plugin-catalog-detail--loading").waitFor();
    expect(await calendar.count()).toBe(0);
    await gateway.resolveDeferred(method, undefined, { match: second });
    await calendar.waitFor();
  });

  it("explains why Install is disabled while plugin inventory is loading", async () => {
    const { page, gateway } = await setup(
      {},
      { heldMethods: ["plugins.list"], awaitInitialRoster: false },
    );
    await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
    await gateway.waitForRequest("plugins.list");

    const install = role(page, "button", "Install");
    const loading = page.getByText("Loading plugins…", { exact: true });
    await install.waitFor();
    expect(await install.isDisabled()).toBe(true);
    await loading.waitFor({ timeout: 1_500 });
    await captureScreenshot(page, "catalog-detail-inventory-pending.png", "viewport");

    await gateway.resolveDeferred("plugins.list");
    await expect.poll(() => install.isEnabled()).toBe(true);
    await loading.waitFor({ state: "detached" });
  });

  it("keeps category navigation while a search replaces pending category results", async () => {
    const { context, page, gateway } = await setup(
      {},
      {
        presenceUsers: [{ self: true, id: "catalog-proof", name: "Catalog Proof" }],
      },
    );
    const origin = new URL(server.baseUrl).origin;
    const blockedRequests: string[] = [];
    await context.route("**/*", async (route) => {
      const url = route.request().url();
      if (new URL(url).origin === origin) {
        await route.continue();
      } else {
        blockedRequests.push(url);
        await route.abort();
      }
    });
    const proofDir =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("plugin-search-category-navigation")
        : undefined;
    await page.goto(`${server.baseUrl}plugins`);
    const catalog = page.getByRole("region", { name: "Explore plugins" });
    const chips = catalog.locator(".plugin-catalog-chip");
    const labels = async () => (await chips.allTextContents()).map((label) => label.trim());
    await expect.poll(labels).toContain("Channels");
    const categories = await labels();
    await page.clock.install();
    await pauseVirtualClock(page);
    await gateway.deferNext("plugins.catalog.browse", { category: "channels" });
    await gateway.deferNext("plugins.catalog.browse", { query: "matrix" });
    await role(catalog, "button", "Channels").click();
    await gateway.waitForRequest("plugins.catalog.browse", { match: { category: "channels" } });
    await catalog.getByRole("searchbox", { name: "Search plugins" }).fill("matrix");
    await gateway.resolveDeferred("plugins.catalog.browse", { items: [matrixDiscoveryPlugin] });
    const cards = catalog.locator(".plugin-catalog-grid--results .plugin-catalog-card");
    // The older category response must not replace loading for the newer search intent.
    const loading = role(catalog, "status", "Loading plugins…");
    await loading.waitFor();
    expect(await cards.count()).toBe(0);
    expect(await gateway.getRequests("plugins.catalog.browse", { query: "matrix" })).toEqual([]);
    const duringDebounce = await labels();
    await page.clock.runFor(250);
    const searchRequest = await gateway.waitForRequest("plugins.catalog.browse", {
      match: { query: "matrix" },
    });
    expect(searchRequest.params).toEqual({
      intent: "all",
      query: "matrix",
      pageSize: 100,
      searchSource: "openclaw-control-ui",
    });
    expect(await loading.isVisible()).toBe(true);
    expect(await labels()).toEqual(categories);
    await gateway.resolveDeferred("plugins.catalog.browse", {
      items: [renamedPlugin(matrixDiscoveryPlugin, "Matrix search result")],
    });
    await role(catalog, "link", "Matrix search result").waitFor();
    expect(await cards.count()).toBe(1);
    expect(await loading.count()).toBe(0);
    if (proofDir) {
      expect(await page.locator(".community-invite-card").count()).toBe(0);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "search-navigation.png"),
      });
      const proof = {
        categories,
        duringDebounce,
        afterSearch: await labels(),
        blockedRequests,
        requests: await gateway.getRequests("plugins.catalog.browse"),
      };
      await writeFile(
        path.join(proofDir, "search-navigation.json"),
        JSON.stringify(proof, null, 2),
      );
    }
    expect.soft(duringDebounce).toEqual(categories);
    expect.soft(await labels()).toEqual(categories);
  });

  it("renders unified discovery with an unfocused search, category sections, and settings navigation", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const responses = pluginMethodResponses();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...responses,
        "plugins.catalog.browse": {
          cases: [
            {
              match: { query: "memory" },
              response: {
                items: discoveryResult.items.filter(
                  (plugin) => plugin.catalog.name === "Memory Plus",
                ),
              },
            },
            ...responses["plugins.catalog.browse"].cases,
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      const catalog = page.getByRole("region", { name: "Explore plugins" });
      const search = catalog.getByRole("searchbox", { name: "Search plugins" });
      await search.waitFor();
      expect(await search.evaluate((element) => element === document.activeElement)).toBe(false);
      expect(
        await page.getByRole("heading", { name: "Installed plugins", exact: true }).count(),
      ).toBe(0);
      expect(await page.getByRole("button", { name: "Plugin settings", exact: true }).count()).toBe(
        1,
      );
      expect(
        (await catalog.locator(".plugin-catalog-chip").allTextContents())
          .map((label) => label.trim())
          .slice(0, 3),
      ).toEqual(["All", "Featured", "Trending"]);
      expect(await catalog.locator(".plugin-catalog-section__header h2").allTextContents()).toEqual(
        expect.arrayContaining(["Featured", "Trending", "Channels", "Scheduling"]),
      );
      expect(await gateway.getRequests("plugins.catalog.browse")).toHaveLength(1);
      expect((await gateway.getRequests("plugins.catalog.browse"))[0]?.params).toEqual({
        intent: "all",
        pageSize: 100,
      });
      const grid = catalog.locator(".plugin-catalog-grid").first();
      await expect
        .poll(() =>
          grid.evaluate(
            (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
          ),
        )
        .toBe(2);
      const installedCard = catalog.locator('[data-plugin-id="ch_bWVtb3J5LXBsdXM"]').first();
      const featured = catalog.locator('[data-catalog-section="featured"]');
      await captureScreenshot(page, "9-unified-plugin-catalog-desktop.png");
      expect(await featured.locator("h3").first().textContent()).toBe("Memory Plus");
      expect(await installedCard.getByText("Installed", { exact: true }).isVisible()).toBe(true);
      expect(await installedCard.getByRole("button").count()).toBe(0);
      const availableCard = catalog
        .locator(`[data-plugin-id="${matrixDiscoveryPlugin.id}"]`)
        .first();
      expect(await availableCard.getByRole("button", { name: /Install/iu }).count()).toBe(1);
      expect(await availableCard.getByText(/downloads/u).count()).toBe(0);

      await search.fill("memory");
      await gateway.waitForRequest("plugins.catalog.browse", { match: { query: "memory" } });
      await installedCard.waitFor();
      expect(await installedCard.getByLabel("Disabled", { exact: true }).count()).toBe(1);
      expect(await installedCard.getByRole("button", { name: /Install/iu }).count()).toBe(0);

      await search.fill("matrix");
      await gateway.waitForRequest("plugins.catalog.browse", {
        match: { intent: "all", query: "matrix", pageSize: 100 },
      });
      expect(await catalog.locator(".plugin-catalog-section").count()).toBe(0);
      expect(
        await catalog.locator(".plugin-catalog-grid--results .plugin-catalog-card").count(),
      ).toBe(1);

      await page.getByRole("button", { name: "Plugin settings", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins");
    } finally {
      await context.close();
    }
  });

  it("opens a routed ClawHub-style plugin detail page with normalized metadata", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });

    try {
      await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
      await page.getByRole("heading", { level: 1, name: "Matrix", exact: true }).waitFor();
      expect(
        (await gateway.getRequests("plugins.catalog.get")).map((request) => request.params),
      ).toContainEqual({ id: matrixDiscoveryPlugin.id });
      expect(
        await page.getByText("Connect OpenClaw to Matrix rooms and direct messages.").count(),
      ).toBe(1);
      const detailPanel = page.locator(".plugin-catalog-detail__panel");
      const detailReadme = page.locator(".plugin-catalog-detail__readme");
      const detailSidebar = page.locator(".plugin-catalog-detail__sidebar");
      await detailPanel.getByText("Matrix messaging", { exact: true }).waitFor();
      await detailReadme
        .getByText("Connect OpenClaw to Matrix rooms and direct messages.")
        .waitFor();
      expect(await page.locator(".plugin-catalog-detail [role=tablist]").count()).toBe(0);
      const [panelBox, readmeBox, sidebarBox] = await Promise.all([
        detailPanel.boundingBox(),
        detailReadme.boundingBox(),
        detailSidebar.boundingBox(),
      ]);
      expect(panelBox).not.toBeNull();
      expect(readmeBox).not.toBeNull();
      expect(sidebarBox).not.toBeNull();
      expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(sidebarBox!.x);
      expect(readmeBox!.x + readmeBox!.width).toBeLessThanOrEqual(sidebarBox!.x);
      expect(await page.getByText("52.2k", { exact: true }).count()).toBe(1);
      expect(await detailSidebar.getByText("Clean", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Type", { exact: true }).count()).toBe(0);
      expect(await page.getByText("code-plugin", { exact: true }).count()).toBe(0);
      expect(
        await detailSidebar
          .getByRole("link", { name: /^openclaw\/\s*openclaw$/u })
          .getAttribute("href"),
      ).toBe("https://github.com/openclaw/openclaw");
      expect(
        await page.getByRole("link", { name: "@openclaw", exact: true }).getAttribute("href"),
      ).toBe("https://clawhub.ai/openclaw");
      expect(await page.getByRole("link", { name: "Security audit" }).getAttribute("href")).toBe(
        "https://clawhub.ai/openclaw/plugins/matrix/security-audit",
      );
      expect(await page.getByRole("link", { name: "View on ClawHub" }).count()).toBe(0);
      expect(await page.getByRole("tab", { name: "Plugins", exact: true }).count()).toBe(0);

      expect(await detailSidebar.getByText("2.1.0", { exact: true }).count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("installs directly and uses Settings for required configuration", async () => {
    const installed = { ...matrixNeedsSetup, catalogId: matrixDiscoveryPlugin.id };
    const { page, gateway } = await setup(
      {
        "config.schema": matrixConfigSchema,
        "plugins.inspect": { ...calendarInspection, plugin: installed },
      },
      { featureMethods: [...pluginMethods, "config.schema"] },
    );
    await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
    const connects = (await gateway.getRequests("connect")).length;
    await gateway.deferNext("plugins.install");
    await role(page, "button", "Install").click();
    expect((await gateway.waitForRequest("plugins.install")).params).toEqual({
      source: "clawhub",
      packageName: "matrix",
    });
    expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
    await captureScreenshot(page, "direct-install-pending.png");
    await setInstalled(gateway, installed);
    await gateway.resolveDeferred("plugins.install", {
      ok: true,
      plugin: installed,
      restartRequired: false,
    });
    const enable = page.getByRole("switch", { name: "Matrix", checked: false, exact: true });
    await enable.waitFor();
    expect(await enable.getAttribute("aria-disabled")).toBe("true");
    await captureScreenshot(page, "direct-install-needs-settings.png");
    await role(page.locator(".plugin-catalog-detail__actions"), "link", "Settings").click();
    await role(page, "textbox", "Homeserver").waitFor();
    expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
    expect(await gateway.getRequests("config.set")).toHaveLength(0);
    expect(await gateway.getRequests("connect")).toHaveLength(connects);
    expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
  });

  it("preserves a deliberately disabled install returned by the Gateway", async () => {
    const installed = { ...localCalendarDisabled, catalogId: localOnlyDiscoveryPlugin.id };
    const { page, gateway } = await setup({
      "plugins.install": { ok: true, plugin: installed, restartRequired: false },
    });
    await page.goto(`${server.baseUrl}plugins/${localOnlyDiscoveryPlugin.id}`);
    await page.getByRole("heading", { level: 1, name: "Local Calendar", exact: true }).waitFor();
    const connects = (await gateway.getRequests("connect")).length;
    await setInstalled(gateway, installed);
    await role(page, "button", "Install").click();
    expect((await gateway.waitForRequest("plugins.install")).params).toEqual({
      source: "official",
      pluginId: "local-calendar",
    });
    await page
      .getByRole("switch", { name: "Local Calendar", checked: false, exact: true })
      .waitFor();
    expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
    expect(await gateway.getRequests("connect")).toHaveLength(connects);
    expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
  });

  it("keeps a failed installation visible and retryable", async () => {
    const { page, gateway } = await setup({
      "plugins.install": {
        __mockError: {
          code: "UNAVAILABLE",
          message: "ClawHub package download failed; check the network and retry.",
        },
      },
    });
    await page.goto(`${server.baseUrl}plugins`);
    const card = page.locator(`[data-plugin-id="${matrixDiscoveryPlugin.id}"]`).first();
    await role(card, "button", "Install Matrix").click();
    const failure = card.locator('.plugins-row-message[role="alert"]');
    await failure
      .getByText("ClawHub package download failed; check the network and retry.")
      .waitFor();
    await gateway.setMethodResponse("plugins.install", {
      __mockError: {
        code: "UNAVAILABLE",
        message: "Plugin startup failed.",
        details: { persistence: { operation: "install", pluginId: matrixEnabled.id } },
      },
    });
    const browseRequests = (await gateway.getRequests("plugins.catalog.browse")).length;
    await gateway.deferNext("plugins.list");
    await gateway.deferNext("plugins.catalog.browse");
    await role(card, "button", "Retry install of Matrix").click();
    const status = role(card, "button", "View status of Matrix installation");
    await status.click();
    await page.mouse.move(1400, 800);
    await card.getByText("Installation saved", { exact: true }).waitFor();
    await gateway.resolveDeferred("plugins.list");
    await gateway.waitForRequest("plugins.catalog.browse", { after: browseRequests });
    await gateway.resolveDeferred("plugins.catalog.browse", {
      ...discoveryResult,
      items: discoveryResult.items.map((plugin) =>
        plugin.id === matrixDiscoveryPlugin.id ? renamedPlugin(plugin, "Matrix refreshed") : plugin,
      ),
    });
    await role(card, "link", "Matrix refreshed").waitFor();
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      const proof = createControlUiE2eArtifactDir("plugin-status-popup");
      await page.screenshot({ path: `${proof}/status.png` });
    }
    await card.getByText("Installation saved", { exact: true }).waitFor();
    expect(await gateway.getRequests("plugins.install")).toHaveLength(2);
  });

  it("recovers an installation after a real connection loss from authoritative inventory", async () => {
    const { page, gateway } = await setup();
    await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
    await gateway.deferNext("plugins.install");
    await role(page, "button", "Install").click();
    await gateway.waitForRequest("plugins.install");
    await setInstalled(gateway, { ...matrixEnabled, catalogId: matrixDiscoveryPlugin.id });
    await reconnectMockGateway(page, gateway);
    await page.getByRole("switch", { name: "Matrix", checked: true, exact: true }).waitFor();
    expect(await gateway.getRequests("plugins.install")).toHaveLength(1);
    expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
    expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
  });

  it("renders local-only discovery without inventing ClawHub popularity or provenance", async () => {
    const { page, gateway } = await setup();
    await page.goto(`${server.baseUrl}plugins`);
    const row = page.locator(`[data-plugin-id="${localOnlyDiscoveryPlugin.id}"]`).first();
    await row.waitFor();
    expect(await text(row, "Local Calendar").count()).toBe(1);
    expect(await row.getByText(/downloads/u).count()).toBe(0);
    await role(row, "link", "Local Calendar").click();
    await page.getByRole("heading", { level: 1, name: "Local Calendar", exact: true }).waitFor();
    expect(
      (await gateway.getRequests("plugins.catalog.get")).map((request) => request.params),
    ).toContainEqual({ id: localOnlyDiscoveryPlugin.id });
    expect(await text(page, "@openclaw").count()).toBe(0);
    expect(await text(page, "Security").count()).toBe(0);
    await text(page.locator(".plugin-capabilities"), "Calendar planning").waitFor();
  });

  it("keeps local-only rows visible beside an isolated ClawHub outage", async () => {
    const message = "ClawHub is unavailable: service unavailable. Local plugins remain available.";
    const { page } = await setup({
      "plugins.catalog.browse": {
        items: [localOnlyDiscoveryPlugin],
        remoteError: message,
      },
    });
    await page.goto(`${server.baseUrl}plugins`);
    const explore = page.getByRole("region", { name: "Explore plugins" });
    await text(explore, "Local Calendar").first().waitFor();
    expect(await text(page, message).count()).toBe(1);
  });

  const shelfCases = [400, 820, 1280]
    .flatMap((width) => [
      [width, 1],
      [width, 0],
    ])
    .concat([[1440, 1]]);
  it.each(shelfCases)(
    "refills sparse overview shelves without shifting at %i px (%i initial models)",
    verifyShelfRefill,
  );

  async function verifyShelfRefill(width: number, initialModels: number) {
    const method = "plugins.catalog.browse";
    const channels = "Matrix Mattermost Signal IRC Slack Zulip LINE Nextcloud".split(" ");
    const models = "Ollama Cohere Mistral DeepSeek Groq Fireworks Together Cerebras".split(" ");
    const memory = "Archive Notes Journal Recall Vault Index Timeline Notebook".split(" ");
    const entries = (
      category: string,
      names: string[],
      installed = false,
    ): typeof discoveryResult.items =>
      names.map((name, index) => {
        const id = name.toLowerCase();
        const pinned = !installed && index === 0;
        return {
          id: "ch_" + Buffer.from(id).toString("base64url"),
          catalog: {
            name,
            author: "catalog",
            summary: `Explore ${name} in OpenClaw.`,
            categories: [category],
            official: false,
            // A pinned entry with the fewest downloads must remain first after the merge.
            downloads: pinned ? 1 : (installed ? 20_000 : 10_000) - index,
            ...(pinned ? { categoryRanks: { [category]: 0 } } : {}),
          },
          local: installed
            ? {
                pluginId: id,
                present: true,
                installed,
                enabled: index % 2 === 0,
                state: index % 2 === 0 ? "enabled" : "disabled",
                action: "manage",
              }
            : matrixDiscoveryPlugin.local,
        };
      });
    const channelItems = entries("channels", channels);
    const modelItems = entries("models", models);
    const memoryItems = entries("memory", memory);
    const categories = discoveryResult
      .categories!.filter(({ slug }) => ["channels", "models", "memory"].includes(slug))
      .map(({ slug, label, description, icon, order }) => ({
        slug,
        label,
        description,
        icon,
        order,
        previewCursor: slug + "-next",
      }));
    const pageParams = (category: string) => ({
      intent: "all",
      category,
      cursor: category + "-next",
      pageSize: 100,
    });
    const { page, gateway } = await setup(
      {
        [method]: {
          items: [
            // The mixed overview also contains Zulip, below the category preview cutoff.
            channelItems[5]!,
            ...channelItems.slice(0, 2),
            ...entries("channels", "Telegram Discord Teams WeChat WhatsApp Nostr".split(" "), true),
            ...modelItems.slice(0, initialModels),
            ...entries(
              "models",
              [
                "Bedrock",
                "OpenAI",
                "Gemini",
                "Azure",
                "Anthropic",
                "Vertex",
                "vLLM",
                "Local",
              ].slice(0, 8 - initialModels),
              true,
            ),
            ...memoryItems,
          ],
          categories,
        },
      },
      {
        deferredRequests: ["channels", "models"].map((category) => ({
          method,
          match: { category },
        })),
      },
      { width, height: 1180 },
    );
    const proofDir =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir(`plugin-sparse-shelves-${width}-${initialModels}`)
        : null;
    await page.goto(server.baseUrl + "plugins");
    const explore = page.getByRole("region", { name: "Explore plugins" });
    const shelf = (slug: string) => explore.locator(`[data-catalog-section="${slug}"]`);
    const cardNames = (slug: string) =>
      shelf(slug).getByRole("heading", { level: 3 }).allTextContents();
    const capture = async (stage: "before" | "after") => {
      if (proofDir && width === 1440) {
        const sections = [shelf("channels"), shelf("models")];
        const frame = await takeControlUiScreenshotFrame(page, explore, sections, {
          animations: "disabled",
          elements: sections,
        });
        await writeFile(path.join(proofDir, stage + ".png"), frame.png);
        await writeFile(
          path.join(proofDir, stage + "-bounds.json"),
          JSON.stringify(frame.elements.map(({ bounds }) => bounds)),
        );
      }
    };
    await expect.poll(() => cardNames("channels")).toEqual(["Matrix", "Mattermost", "Zulip"]);
    const visibleCount = width === 400 ? 5 : width === 820 ? 6 : 8;
    expect(await cardNames("models")).toEqual(models.slice(0, initialModels));
    expect(await cardNames("memory")).toEqual(memory.slice(0, visibleCount));
    const headingTops = () =>
      explore
        .locator("section h2")
        .evaluateAll((headings) =>
          Object.fromEntries(headings.map((h) => [h.textContent, h.getBoundingClientRect().y])),
        );
    await waitForControlUiProofSurface(explore, [shelf("memory")]);
    await waitForControlUiFrameLayout([explore]);
    await capture("before");
    const held = await headingTops();
    const shifts = await observeLayoutShifts(page);
    const stages = [];
    // No user action: the overview stays readable while its continuation requests are held.
    for (const [category, remainder] of [
      ["channels", channelItems.slice(2)],
      ["models", modelItems.slice(initialModels)],
    ] as const) {
      const params = pageParams(category);
      await expect
        .poll(() => gateway.getRequests(method, params, { exactParams: true }))
        .toHaveLength(1);
      await gateway.resolveDeferred(method, { items: remainder }, { match: params });
      await expect
        .poll(() => cardNames(category))
        .toEqual((category === "channels" ? channels : models).slice(0, visibleCount));
      await waitForControlUiFrameLayout([explore]);
      stages.push(await headingTops());
    }
    const observed = await shifts.evaluate((probe) => probe.read());
    await shifts.evaluate((probe) => probe.stop());
    await shifts.dispose();
    expect(await cardNames("memory")).toEqual(memory.slice(0, visibleCount));
    expect(await gateway.getRequests(method, { category: "memory" })).toHaveLength(0);
    await capture("after");
    if (proofDir) {
      await writeFile(
        path.join(proofDir, "layout.json"),
        JSON.stringify({ width, initialModels, visibleCount, held, stages, observed }, null, 2),
      );
    }
    expect(stages).toEqual([held, held]);
    expect(observed.value).toBe(0);
  }

  it("renders grouped catalog cards and switches to raw filtered results", async () => {
    const { page, gateway } = await setup();
    await page.goto(`${server.baseUrl}plugins`);
    const explore = page.getByRole("region", { name: "Explore plugins" });
    await role(explore, "heading", "Featured").waitFor();
    const categoryLabels = await explore.locator(".plugin-catalog-chips button").allTextContents();
    expect(categoryLabels.map((label) => label.trim()).join(" | ")).toBe(
      "All | Featured | Trending | Channels | Models | Agent runtimes | Memory | Context | Voice | Web | Computer use | Media | Security | Integrations | Developer tools | Infrastructure | Documents & files | Inbox & collaboration | Productivity | Scheduling | Finance & payments | Sales & marketing | Data & analytics | Agent orchestration | Research",
    );
    const sections = explore.locator(".plugin-catalog-section");
    expect((await sections.locator("h2").allTextContents()).slice(0, 2)).toEqual([
      "Featured",
      "Trending",
    ]);
    expect(await sections.first().locator(".plugin-catalog-card").count()).toBe(8);
    expect(await sections.nth(1).getByRole("link", { name: "Memory Plus" }).count()).toBe(0);
    expect(await sections.first().getByRole("button", { name: "View all" }).count()).toBe(1);
    const matrixCard = explore.locator(`[data-plugin-id="${matrixDiscoveryPlugin.id}"]`).first();
    await matrixCard.waitFor();
    expect(await matrixCard.getByText("@openclaw", { exact: true }).count()).toBe(1);
    expect(await matrixCard.getByLabel("Official", { exact: true }).count()).toBe(1);
    expect(await matrixCard.getByText(/downloads/u).count()).toBe(0);
    expect(await matrixCard.getByRole("button", { name: "Install Matrix" }).count()).toBe(1);
    await role(explore, "button", "Documents & files").click();
    await expectBrowse(gateway, {
      intent: "all",
      category: "documents-files",
      pageSize: 100,
    });
    // Seeing the request does not mean its response has replaced the overview yet.
    await expect.poll(() => sections.count()).toBe(0);
    await role(explore, "link", "Matrix").waitFor();
    const search = explore.getByRole("searchbox", { name: "Search plugins" });
    await search.fill("matrix");
    await expectBrowse(gateway, {
      intent: "all",
      query: "matrix",
      pageSize: 100,
      searchSource: "openclaw-control-ui",
    });
    await expect.poll(() => sections.count()).toBe(0);
    await expect
      .poll(() => explore.locator(".plugin-catalog-grid--results .plugin-catalog-card").count())
      .toBe(1);
    await matrixCard.locator(".plugin-catalog-card__primary-link").click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(`/plugins/${matrixDiscoveryPlugin.id}`);
    await page.goto(`${server.baseUrl}plugins`);
    await page.setViewportSize({ height: 1024, width: 768 });
    await role(explore, "button", "Scheduling").click();
    await expectBrowse(gateway, {
      intent: "all",
      category: "scheduling",
      pageSize: 100,
    });
    const grid = page.locator(".plugin-catalog-grid").first();
    const columns = () =>
      grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
    await expect.poll(columns).toBe(1);
    await page.setViewportSize({ height: 852, width: 393 });
    await expect.poll(columns).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
            window.innerWidth,
        ),
      )
      .toBeLessThanOrEqual(1);
  });

  it("hides Other and Uncategorized shelves on mobile while retaining search results", async () => {
    const uncategorized = Array.from({ length: 3 }, (_, index) => ({
      ...matrixDiscoveryPlugin,
      id: `ch_dW5jYXRlZ29yaXplZA_${index}`,
      catalog: {
        ...matrixDiscoveryPlugin.catalog,
        name: `Uncategorized ${index + 1}`,
        categories: ["missing-category"],
      },
    }));
    const featured = discoveryResult.items.filter((plugin) => plugin.catalog.featured).slice(0, 2);
    const other = {
      ...matrixDiscoveryPlugin,
      id: "ch_b3RoZXI",
      catalog: { ...matrixDiscoveryPlugin.catalog, name: "Other plugin", categories: ["other"] },
    };
    const { page, gateway } = await setup(
      {
        "plugins.catalog.browse": {
          cases: [
            { match: { query: "uncategorized" }, response: { items: uncategorized } },
            {
              match: { intent: "all", pageSize: 100 },
              response: {
                items: [...featured, ...uncategorized, other],
                categories: discoveryResult.categories,
              },
            },
          ],
        },
      },
      {},
      { height: 852, width: 393 },
    );
    await page.goto(`${server.baseUrl}plugins`);
    const explore = page.getByRole("region", { name: "Explore plugins" });
    const featuredSection = explore.locator('[data-catalog-section="featured"]');
    await featuredSection.waitFor();
    expect(await explore.locator('[data-catalog-section="uncategorized"]').count()).toBe(0);
    expect(await explore.locator('[data-catalog-section="other"]').count()).toBe(0);
    expect(await role(explore, "button", "Other").count()).toBe(0);
    const visibleCards = (root: Locator) =>
      root.evaluateAll(
        (cards) => cards.filter((card) => getComputedStyle(card).display !== "none").length,
      );
    expect(await visibleCards(featuredSection.locator(".plugin-catalog-card"))).toBe(2);
    expect(await featuredSection.getByRole("button", { name: "View all" }).count()).toBe(1);
    await explore.getByRole("searchbox", { name: "Search plugins" }).fill("uncategorized");
    await gateway.waitForRequest("plugins.catalog.browse", { match: { query: "uncategorized" } });
    await role(explore, "link", "Uncategorized 3").waitFor();
    expect(
      await visibleCards(page.locator(".plugin-catalog-grid--results .plugin-catalog-card")),
    ).toBe(3);
    expect(await explore.locator(".plugin-catalog-section").count()).toBe(0);
  });

  it("keeps plugin mutations unavailable to read-only operators", async () => {
    const { page, gateway } = await setup({ connect: readOnlyConnectResponse() });
    await page.goto(`${server.baseUrl}plugins`);
    const availableCard = page.locator(`[data-plugin-id="${localOnlyDiscoveryPlugin.id}"]`).first();
    await availableCard.waitFor({ state: "visible" });
    const installFromCatalog = availableCard.getByRole("button", { name: /Install/iu });
    expect(await installFromCatalog.isDisabled()).toBe(true);
    await installFromCatalog.evaluate((button: HTMLButtonElement) => button.click());
    expect(new URL(page.url()).pathname).toBe("/plugins");
    expect(await gateway.getRequests("plugins.setEnabled")).toEqual([]);
    expect(await gateway.getRequests("plugins.install")).toEqual([]);
    await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
    const install = role(page, "button", "Install");
    await install.waitFor();
    expect(await install.isDisabled()).toBe(true);
    await install.evaluate((button: HTMLButtonElement) => button.click());
    await captureScreenshot(page, "read-only-install.png");
    expect(await gateway.getRequests("plugins.install")).toEqual([]);
    await page.goto(`${server.baseUrl}plugins`);
    await role(availableCard, "link", "Local Calendar").click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(`/plugins/${localOnlyDiscoveryPlugin.id}`);
  });

  it("recovers unified discovery after a ClawHub retry", async () => {
    const { page, gateway } = await setup({
      "plugins.catalog.browse": {
        __mockError: {
          code: "UNAVAILABLE",
          message: "Plugin discovery is unavailable. Retry to reconnect to ClawHub.",
        },
      },
    });
    await page.goto(`${server.baseUrl}plugins`);
    const discoveryError = page.locator('.plugin-catalog-results [role="alert"]').first();
    await discoveryError.waitFor();
    expect(await discoveryError.textContent()).toContain("Plugin discovery is unavailable");
    await gateway.setMethodResponse("plugins.catalog.browse", { items: discoveryResult.items });
    await discoveryError.getByRole("button", { name: "Try again" }).click();
    await page.locator('.plugin-catalog-card[data-plugin-id="ch_bWF0cml4"]').first().waitFor();
  });

  it("explains a successful empty ClawHub response", async () => {
    const { page } = await setup({ "plugins.catalog.browse": { items: [] } });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(`${server.baseUrl}plugins`);
    await text(page, "No plugins match your search.").waitFor();
    await text(page, "Try a different search or choose another filter.").waitFor();
    expect(await page.locator(".plugin-catalog-card").count()).toBe(0);
    if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
      const proof = createControlUiE2eArtifactDir("plugin-empty-search");
      await page.getByRole("region", { name: "Explore plugins" }).screenshot({
        animations: "disabled",
        path: path.join(proof, "empty-search.png"),
      });
    }
  });

  it("reloads ClawHub discovery after the Gateway reconnects", async () => {
    const { page, gateway } = await setup();
    await page.goto(`${server.baseUrl}plugins`);
    await page.locator('.plugin-catalog-card[data-plugin-id="ch_bWF0cml4"]').first().waitFor();
    const requestsBeforeReconnect = (await gateway.getRequests("plugins.catalog.browse")).length;
    const discoveryPlugin = discoveryResult.items.find((plugin) => !plugin.local.installed);
    if (!discoveryPlugin) {
      throw new Error("Expected the discovery fixture to contain a plugin.");
    }
    await gateway.setMethodResponse("plugins.catalog.browse", {
      items: [renamedPlugin(discoveryPlugin, "Memory Reconnected")],
    });
    await reconnectMockGateway(page, gateway);
    await gateway.waitForRequest("plugins.catalog.browse", { after: requestsBeforeReconnect });
    await page.locator(".plugin-catalog-card", { hasText: "Memory Reconnected" }).first().waitFor();
  });
});
