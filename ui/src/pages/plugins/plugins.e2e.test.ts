// Control UI tests cover plugin catalog browsing and lifecycle mutations.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
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

describeControlUiE2e("Control UI Plugins mocked Gateway E2E", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("keeps category navigation while a search replaces pending category results", async () => {
    const context = await newContext();
    const page = await context.newPage();
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
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      presenceUsers: [{ self: true, id: "catalog-proof", name: "Catalog Proof" }],
      methodResponses: pluginMethodResponses(),
    });
    const proofDir =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("plugin-search-category-navigation")
        : undefined;
    try {
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
      await catalog.getByRole("button", { name: "Channels", exact: true }).click();
      await gateway.waitForRequest("plugins.catalog.browse", { match: { category: "channels" } });
      await catalog.getByRole("searchbox", { name: "Search plugins" }).fill("matrix");
      await gateway.resolveDeferred("plugins.catalog.browse", { items: [matrixDiscoveryPlugin] });
      const cards = catalog.locator(".plugin-catalog-grid--results .plugin-catalog-card");
      // The older category response must not replace loading for the newer search intent.
      const loading = catalog.getByRole("status", {
        name: "Loading ClawHub plugins…",
        exact: true,
      });
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
        items: [
          {
            ...matrixDiscoveryPlugin,
            catalog: { ...matrixDiscoveryPlugin.catalog, name: "Matrix search result" },
          },
        ],
      });
      await catalog.getByRole("link", { name: "Matrix search result", exact: true }).waitFor();
      expect(await cards.count()).toBe(1);
      expect(await loading.count()).toBe(0);
      if (proofDir) {
        expect(await page.locator(".community-invite-card").count()).toBe(0);
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "search-navigation.png"),
        });
        await writeFile(
          path.join(proofDir, "search-navigation.json"),
          JSON.stringify(
            {
              categories,
              duringDebounce,
              afterSearch: await labels(),
              blockedRequests,
              requests: await gateway.getRequests("plugins.catalog.browse"),
            },
            null,
            2,
          ),
        );
      }
      expect.soft(duringDebounce).toEqual(categories);
      expect.soft(await labels()).toEqual(categories);
    } finally {
      await context.close();
    }
  });

  it("installs directly and uses Settings for required configuration", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const installed = { ...matrixNeedsSetup, catalogId: matrixDiscoveryPlugin.id };
    const gateway = await installMockGateway(page, {
      featureMethods: [...pluginMethods, "config.schema"],
      methodResponses: {
        ...pluginMethodResponses(),
        "config.schema": matrixConfigSchema,
        "plugins.inspect": { ...calendarInspection, plugin: installed },
      },
    });
    try {
      await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
      const connects = (await gateway.getRequests("connect")).length;
      await gateway.deferNext("plugins.install");
      await page.getByRole("button", { name: "Install", exact: true }).click();
      expect((await gateway.waitForRequest("plugins.install")).params).toEqual({
        source: "clawhub",
        packageName: "matrix",
      });
      expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
      await captureScreenshot(page, "direct-install-pending.png");
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([...initialInventory.plugins, installed]),
      );
      await gateway.resolveDeferred("plugins.install", {
        ok: true,
        plugin: installed,
        restartRequired: false,
      });
      const enable = page.getByRole("button", { name: "Enable Matrix", exact: true });
      await enable.waitFor();
      expect(await enable.getAttribute("aria-disabled")).toBe("true");
      await captureScreenshot(page, "direct-install-needs-settings.png");
      await page
        .locator(".plugin-catalog-detail__actions")
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      await page.getByRole("textbox", { name: "Homeserver", exact: true }).waitFor();
      expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("preserves a deliberately disabled install returned by the Gateway", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const installed = { ...localCalendarDisabled, catalogId: localOnlyDiscoveryPlugin.id };
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.install": { ok: true, plugin: installed, restartRequired: false },
      },
    });
    try {
      await page.goto(`${server.baseUrl}plugins/${localOnlyDiscoveryPlugin.id}`);
      await page.getByRole("heading", { level: 1, name: "Local Calendar", exact: true }).waitFor();
      const connects = (await gateway.getRequests("connect")).length;
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([...initialInventory.plugins, installed]),
      );
      await page.getByRole("button", { name: "Install", exact: true }).click();
      expect((await gateway.waitForRequest("plugins.install")).params).toEqual({
        source: "official",
        pluginId: "local-calendar",
      });
      await page.getByRole("button", { name: "Enable Local Calendar", exact: true }).waitFor();
      expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("keeps a failed installation visible and retryable", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.install": {
          __mockError: {
            code: "UNAVAILABLE",
            message: "ClawHub package download failed; check the network and retry.",
          },
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      const card = page.locator(`[data-plugin-id="${matrixDiscoveryPlugin.id}"]`).first();
      await card.getByRole("button", { name: "Install Matrix", exact: true }).click();
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
      await card.getByRole("button", { name: "Retry install of Matrix", exact: true }).click();
      const status = card.getByRole("button", {
        name: "View status of Matrix installation",
        exact: true,
      });
      await status.click();
      await page.mouse.move(1400, 800);
      await card.getByText("Installation saved", { exact: true }).waitFor();
      await gateway.resolveDeferred("plugins.list");
      await gateway.waitForRequest("plugins.catalog.browse", { after: browseRequests });
      await gateway.resolveDeferred("plugins.catalog.browse", {
        ...discoveryResult,
        items: discoveryResult.items.map((plugin) =>
          plugin.id === matrixDiscoveryPlugin.id
            ? { ...plugin, catalog: { ...plugin.catalog, name: "Matrix refreshed" } }
            : plugin,
        ),
      });
      await card.getByRole("link", { name: "Matrix refreshed", exact: true }).waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const proof = createControlUiE2eArtifactDir("plugin-status-popup");
        await page.screenshot({ path: `${proof}/status.png` });
      }
      await card.getByText("Installation saved", { exact: true }).waitFor();
      expect(await gateway.getRequests("plugins.install")).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("recovers an installation after a real connection loss from authoritative inventory", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });

    try {
      await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
      await gateway.deferNext("plugins.install");
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await gateway.waitForRequest("plugins.install");
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([
          ...initialInventory.plugins,
          { ...matrixEnabled, catalogId: matrixDiscoveryPlugin.id },
        ]),
      );
      await reconnectMockGateway(page, gateway);
      await page.getByRole("button", { name: "Disable Matrix", exact: true }).waitFor();
      expect(await gateway.getRequests("plugins.install")).toHaveLength(1);
      expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("renders local-only discovery without inventing ClawHub popularity or provenance", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      const row = page.locator(`[data-plugin-id="${localOnlyDiscoveryPlugin.id}"]`).first();
      await row.waitFor();
      expect(await row.getByText("Local Calendar", { exact: true }).count()).toBe(1);
      expect(await row.getByText(/downloads/u).count()).toBe(0);

      await row.getByRole("link", { name: "Local Calendar", exact: true }).click();
      await page.getByRole("heading", { level: 1, name: "Local Calendar", exact: true }).waitFor();
      expect(
        (await gateway.getRequests("plugins.catalog.get")).map((request) => request.params),
      ).toContainEqual({ id: localOnlyDiscoveryPlugin.id });
      expect(await page.getByText("@openclaw", { exact: true }).count()).toBe(0);
      expect(await page.getByText("Security", { exact: true }).count()).toBe(0);
      await page
        .locator(".plugin-capabilities")
        .getByText("Calendar planning", { exact: true })
        .waitFor();
    } finally {
      await context.close();
    }
  });

  it("keeps local-only rows visible beside an isolated ClawHub outage", async () => {
    const context = await newContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.catalog.browse": {
          items: [localOnlyDiscoveryPlugin],
          remoteError:
            "ClawHub is unavailable: service unavailable. Local plugins remain available.",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      const explore = page.getByRole("region", { name: "Explore plugins" });
      await explore.getByText("Local Calendar", { exact: true }).first().waitFor();
      expect(
        await page
          .getByText(
            "ClawHub is unavailable: service unavailable. Local plugins remain available.",
            { exact: true },
          )
          .count(),
      ).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("renders grouped catalog cards and switches to raw filtered results", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      const explore = page.getByRole("region", { name: "Explore plugins" });
      await explore.getByRole("heading", { name: "Featured", exact: true }).waitFor();
      const categoryLabels = await explore
        .locator(".plugin-catalog-chips button")
        .allTextContents();
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

      await explore.getByRole("button", { name: "Documents & files", exact: true }).click();
      // Match full results, excluding section previews, then select the first page.
      const categoryRequest = await gateway.waitForRequest("plugins.catalog.browse", {
        after: 0,
        match: { intent: "all", category: "documents-files", pageSize: 100 },
      });
      expect(categoryRequest.params).toEqual({
        intent: "all",
        category: "documents-files",
        pageSize: 100,
      });
      expect(await explore.locator(".plugin-catalog-section").count()).toBe(0);
      await explore.getByRole("link", { name: "Matrix", exact: true }).waitFor();

      const search = explore.getByRole("searchbox", { name: "Search plugins" });
      await search.fill("matrix");
      const searchRequest = await gateway.waitForRequest("plugins.catalog.browse", {
        after: 0,
        match: { intent: "all", query: "matrix", pageSize: 100 },
      });
      expect(searchRequest.params).toEqual({
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
      await explore.getByRole("button", { name: "Scheduling", exact: true }).click();
      // The fresh page may still issue its initial unfiltered browse request.
      const mobileCategoryRequest = await gateway.waitForRequest("plugins.catalog.browse", {
        after: 0,
        match: { intent: "all", category: "scheduling", pageSize: 100 },
      });
      expect(mobileCategoryRequest.params).toEqual({
        intent: "all",
        category: "scheduling",
        pageSize: 100,
      });
      const grid = page.locator(".plugin-catalog-grid").first();
      await expect
        .poll(() =>
          grid.evaluate(
            (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
          ),
        )
        .toBe(2);
      await page.setViewportSize({ height: 852, width: 393 });
      await expect
        .poll(() =>
          grid.evaluate(
            (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
          ),
        )
        .toBe(1);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
              window.innerWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });

  it("hides Other and Uncategorized shelves on mobile while retaining search results", async () => {
    const context = await newContext({ height: 852, width: 393 });
    const page = await context.newPage();
    const uncategorized = Array.from({ length: 3 }, (_, index) => ({
      ...matrixDiscoveryPlugin,
      id: `ch_dW5jYXRlZ29yaXplZA_${index}`,
      catalog: {
        ...matrixDiscoveryPlugin.catalog,
        name: `Uncategorized ${index + 1}`,
        categories: ["missing-category"],
      },
    }));
    const featuredOverviewItems = discoveryResult.items
      .filter((plugin) => plugin.catalog.featured)
      .slice(0, 2);
    const other = {
      ...matrixDiscoveryPlugin,
      id: "ch_b3RoZXI",
      catalog: { ...matrixDiscoveryPlugin.catalog, name: "Other plugin", categories: ["other"] },
    };
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.catalog.browse": {
          cases: [
            {
              match: { query: "uncategorized" },
              response: { items: uncategorized },
            },
            {
              match: { intent: "all", pageSize: 100 },
              response: {
                items: [...featuredOverviewItems, ...uncategorized, other],
                categories: discoveryResult.categories,
              },
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      const explore = page.getByRole("region", { name: "Explore plugins" });
      const featuredSection = explore.locator('[data-catalog-section="featured"]');
      await featuredSection.waitFor();
      expect(await explore.locator('[data-catalog-section="uncategorized"]').count()).toBe(0);
      expect(await explore.locator('[data-catalog-section="other"]').count()).toBe(0);
      expect(await explore.getByRole("button", { name: "Other", exact: true }).count()).toBe(0);

      const visibleCardCount = async (selector: string) =>
        page
          .locator(selector)
          .evaluateAll(
            (cards) => cards.filter((card) => getComputedStyle(card).display !== "none").length,
          );
      expect(await visibleCardCount('[data-catalog-section="featured"] .plugin-catalog-card')).toBe(
        2,
      );
      expect(await featuredSection.getByRole("button", { name: "View all" }).count()).toBe(1);

      await explore.getByRole("searchbox", { name: "Search plugins" }).fill("uncategorized");
      await gateway.waitForRequest("plugins.catalog.browse", { match: { query: "uncategorized" } });
      await explore.getByRole("link", { name: "Uncategorized 3", exact: true }).waitFor();
      expect(await visibleCardCount(".plugin-catalog-grid--results .plugin-catalog-card")).toBe(3);
      expect(await explore.locator(".plugin-catalog-section").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("keeps plugin mutations unavailable to read-only operators", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        connect: readOnlyConnectResponse(),
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      const availableCard = page
        .locator(`[data-plugin-id="${localOnlyDiscoveryPlugin.id}"]`)
        .first();
      await availableCard.waitFor({ state: "visible" });
      const installFromCatalog = availableCard.getByRole("button", { name: /Install/iu });
      expect(await installFromCatalog.isDisabled()).toBe(true);
      await installFromCatalog.evaluate((button: HTMLButtonElement) => button.click());
      expect(new URL(page.url()).pathname).toBe("/plugins");
      expect(await gateway.getRequests("plugins.setEnabled")).toEqual([]);
      expect(await gateway.getRequests("plugins.install")).toEqual([]);
      await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
      const install = page.getByRole("button", { name: "Install", exact: true });
      await install.waitFor();
      expect(await install.isDisabled()).toBe(true);
      await install.evaluate((button: HTMLButtonElement) => button.click());
      await captureScreenshot(page, "read-only-install.png");
      expect(await gateway.getRequests("plugins.install")).toEqual([]);
      await page.goto(`${server.baseUrl}plugins`);
      await availableCard.getByRole("link", { name: "Local Calendar", exact: true }).click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(`/plugins/${localOnlyDiscoveryPlugin.id}`);
    } finally {
      await context.close();
    }
  });

  it("recovers unified discovery after a ClawHub retry", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.catalog.browse": {
          __mockError: {
            code: "UNAVAILABLE",
            message: "Plugin discovery is unavailable. Retry to reconnect to ClawHub.",
          },
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      const discoveryError = page.locator('.plugin-catalog-results [role="alert"]').first();
      await discoveryError.waitFor();
      expect(await discoveryError.textContent()).toContain("Plugin discovery is unavailable");
      await gateway.setMethodResponse("plugins.catalog.browse", { items: discoveryResult.items });
      await discoveryError.getByRole("button", { name: "Try again" }).click();
      await page.locator('.plugin-catalog-card[data-plugin-id="ch_bWF0cml4"]').first().waitFor();
    } finally {
      await context.close();
    }
  });

  it("explains a successful empty ClawHub response", async () => {
    const context = await newContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.catalog.browse": { items: [] },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      await page.getByText("No plugins found", { exact: true }).waitFor();
      await page
        .getByText("Try a different search or choose another filter.", { exact: true })
        .waitFor();
      expect(await page.locator(".plugin-catalog-card").count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("reloads ClawHub discovery after the Gateway reconnects", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      await page.locator('.plugin-catalog-card[data-plugin-id="ch_bWF0cml4"]').first().waitFor();
      const requestsBeforeReconnect = (await gateway.getRequests("plugins.catalog.browse")).length;
      const discoveryPlugin = discoveryResult.items.find((plugin) => !plugin.local.installed);
      if (!discoveryPlugin) {
        throw new Error("Expected the discovery fixture to contain a plugin.");
      }
      await gateway.setMethodResponse("plugins.catalog.browse", {
        items: [
          {
            ...discoveryPlugin,
            catalog: { ...discoveryPlugin.catalog, name: "Memory Reconnected" },
          },
        ],
      });

      await reconnectMockGateway(page, gateway);
      await gateway.waitForRequest("plugins.catalog.browse", { after: requestsBeforeReconnect });
      await page
        .locator(".plugin-catalog-card", { hasText: "Memory Reconnected" })
        .first()
        .waitFor();
    } finally {
      await context.close();
    }
  });
});
