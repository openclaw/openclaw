import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { pauseVirtualClock, reconnectMockGateway } from "../../test-helpers/control-ui-e2e.ts";
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
  matrixDiscoveryPlugin,
  matrixEnabled,
  matrixNeedsSetup,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  readOnlyConnectResponse,
  server,
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

async function setup(
  methodResponses: Record<string, unknown> = {},
  options: NonNullable<Parameters<typeof installMockGateway>[1]> = {},
  viewport?: Parameters<typeof newContext>[0],
) {
  const context = await newContext(viewport);
  onTestFinished(() => context.close());
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    featureMethods: pluginMethods,
    methodResponses: { ...pluginMethodResponses(), ...methodResponses },
    ...options,
  });
  return { page, gateway, context };
}

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
    const loading = role(catalog, "status", "Loading ClawHub plugins…");
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

  it("renders unified discovery with focused search, category sections, and settings navigation", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      const catalog = page.getByRole("region", { name: "Explore plugins" });
      const search = catalog.getByRole("searchbox", { name: "Search plugins" });
      await search.waitFor();
      await expect
        .poll(() => search.evaluate((element) => element === document.activeElement))
        .toBe(true);
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
        expect.arrayContaining(["Featured", "Trending", "Channels", "Memory"]),
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
        .toBe(4);
      const installedCard = catalog.locator('[data-plugin-id="ch_bWVtb3J5LXBsdXM"]').first();
      await installedCard.waitFor();
      expect(await installedCard.getByLabel("Disabled", { exact: true }).count()).toBe(1);
      expect(await installedCard.getByRole("button", { name: /Install/iu }).count()).toBe(0);
      const availableCard = catalog
        .locator(`[data-plugin-id="${matrixDiscoveryPlugin.id}"]`)
        .first();
      expect(await availableCard.getByRole("button", { name: /Install/iu }).count()).toBe(1);
      expect(await availableCard.getByText(/downloads/u).count()).toBe(0);
      await captureScreenshot(page, "9-unified-plugin-catalog-desktop.png");

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
          .getByRole("link", { name: "openclaw/openclaw", exact: true })
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
      expect(
        await page.getByRole("button", { name: "Install", exact: true }).evaluate((button) => {
          const probe = document.createElement("span");
          probe.style.background = "var(--primary)";
          document.body.append(probe);
          const expected = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return getComputedStyle(button).backgroundColor === expected;
        }),
      ).toBe(true);

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
    const enable = role(page, "button", "Enable Matrix");
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
    await role(page, "button", "Enable Local Calendar").waitFor();
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
    await role(page, "button", "Disable Matrix").waitFor();
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
    expect(await explore.locator(".plugin-catalog-section").count()).toBe(0);
    await role(explore, "link", "Matrix").waitFor();
    const search = explore.getByRole("searchbox", { name: "Search plugins" });
    await search.fill("matrix");
    await expectBrowse(gateway, {
      intent: "all",
      query: "matrix",
      pageSize: 100,
      searchSource: "openclaw-control-ui",
    });
    expect(await explore.locator(".plugin-catalog-section").count()).toBe(0);
    expect(
      await explore.locator(".plugin-catalog-grid--results .plugin-catalog-card").count(),
    ).toBe(1);
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
    await expect.poll(columns).toBe(2);
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
    await page.goto(`${server.baseUrl}plugins`);
    await text(page, "No plugins found").waitFor();
    await text(page, "Try a different search or choose another filter.").waitFor();
    expect(await page.locator(".plugin-catalog-card").count()).toBe(0);
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
