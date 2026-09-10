// Control UI tests cover plugin catalog browsing and lifecycle mutations.
import { afterAll, beforeAll, expect, it } from "vitest";
import { reconnectMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import {
  captureScreenshot,
  describeControlUiE2e,
  discoveryResult,
  initialInventory,
  installMockGateway,
  inventory,
  localCalendarDisabled,
  localCalendarEnabled,
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
      const detailTabs = page.locator("wa-tab-group.plugin-catalog-detail__tabs");
      const detailMain = page.locator(".plugin-catalog-detail__hero main");
      const detailSidebar = page.locator(".plugin-catalog-detail__sidebar");
      await detailTabs.waitFor();
      expect(
        (await detailTabs.locator("wa-tab").allTextContents())
          .map((text) => text.trim())
          .toSorted(),
      ).toEqual(["Advanced", "Compatibility", "Configuration", "README", "Skills", "Versions"]);
      const [mainBox, tabsBox, sidebarBox] = await Promise.all([
        detailMain.boundingBox(),
        detailTabs.boundingBox(),
        detailSidebar.boundingBox(),
      ]);
      expect(mainBox).not.toBeNull();
      expect(tabsBox).not.toBeNull();
      expect(sidebarBox).not.toBeNull();
      expect(tabsBox!.x + tabsBox!.width).toBeLessThanOrEqual(sidebarBox!.x);
      expect(tabsBox!.y - (mainBox!.y + mainBox!.height)).toBeLessThanOrEqual(24);
      expect(await page.getByText("52.2k", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Pass", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Type", { exact: true }).count()).toBe(0);
      expect(await page.getByText("code-plugin", { exact: true }).count()).toBe(0);
      expect(await page.getByRole("link", { name: "openclaw/openclaw", exact: true }).count()).toBe(
        0,
      );
      expect(
        await page.getByRole("link", { name: "@openclaw", exact: true }).getAttribute("href"),
      ).toBe("https://clawhub.ai/openclaw");
      expect(await page.getByRole("link", { name: "Security audit" }).getAttribute("href")).toBe(
        "https://clawhub.ai/openclaw/plugins/matrix/security-audit",
      );
      expect(await page.getByRole("link", { name: "View on ClawHub" }).getAttribute("href")).toBe(
        "https://clawhub.ai/openclaw/plugins/matrix",
      );
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

      await detailTabs.getByRole("tab", { name: "Versions" }).click();
      expect(await page.getByText("2.1.0", { exact: true }).count()).toBe(1);
      expect(await page.getByText("Current release", { exact: true }).count()).toBe(1);
    } finally {
      await context.close();
    }
  });

  it("installs, configures, and enables a catalog plugin across Gateway restarts", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...pluginMethods, "config.schema", "config.set"],
      methodResponses: {
        ...pluginMethodResponses(),
        "config.schema": matrixConfigSchema,
        "plugins.list": {
          sequence: [
            initialInventory,
            inventory([...initialInventory.plugins, matrixNeedsSetup]),
            inventory([...initialInventory.plugins, matrixNeedsSetup]),
            inventory([...initialInventory.plugins, matrixNeedsSetup]),
            inventory([...initialInventory.plugins, matrixEnabled]),
          ],
        },
        "plugins.install": {
          ok: true,
          plugin: matrixNeedsSetup,
          restartRequired: true,
        },
        "plugins.setEnabled": {
          ok: true,
          plugin: matrixEnabled,
          restartRequired: true,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
      await page.getByRole("heading", { level: 1, name: "Matrix", exact: true }).waitFor();
      await page.getByRole("button", { name: "Install", exact: true }).click();

      const wizard = page.locator('openclaw-modal-dialog[label="Install Matrix"]');
      await wizard.waitFor();
      expect(await wizard.textContent()).toContain("ClawHub · matrix");
      expect(await wizard.textContent()).toContain("Gateway restart");
      expect(await wizard.textContent()).toContain("Matrix messaging");
      await wizard.getByRole("button", { name: "Install Matrix", exact: true }).click();

      const installRequest = await gateway.waitForRequest("plugins.install");
      expect(installRequest.params).toEqual({ source: "clawhub", packageName: "matrix" });
      expect((await gateway.waitForRequest("gateway.restart.request")).params).toEqual({
        reason: "Apply an installed plugin change",
      });
      const cancel = await wizard.evaluate((element) => {
        const event = new CustomEvent("modal-cancel", { cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(cancel).toBe(true);
      expect(await wizard.count()).toBe(1);
      await reconnectMockGateway(page, gateway, "plugins-install-configuring");

      await expect
        .poll(() => wizard.locator(".plugin-install-wizard").getAttribute("data-stage"), {
          timeout: 5_000,
        })
        .toBe("configuring");
      await expect.poll(() => wizard.textContent(), { timeout: 5_000 }).toContain("Homeserver");
      await wizard.getByRole("textbox", { name: "Homeserver" }).fill("https://matrix.example");
      await wizard.getByRole("textbox", { name: "Access token" }).fill("secret-token");
      await wizard.getByRole("combobox", { name: "Mode" }).selectOption("__null__");
      await wizard.getByRole("button", { name: "Save and enable", exact: true }).click();

      const configSet = await gateway.waitForRequest("config.set");
      expect(JSON.parse(String((configSet.params as { raw?: unknown }).raw))).toEqual({
        plugins: {
          entries: {
            workboard: { enabled: false },
            matrix: {
              config: {
                homeserver: "https://matrix.example",
                accessToken: "secret-token",
                mode: null,
              },
            },
          },
        },
      });
      await gateway.waitForRequest("plugins.setEnabled");
      await expect
        .poll(async () => (await gateway.getRequests("gateway.restart.request")).length)
        .toBe(2);
      await reconnectMockGateway(page, gateway, "plugins-install-enabled");
      await wizard.getByText("Plugin ready", { exact: true }).waitFor();
      expect(await gateway.getRequests("config.set")).toHaveLength(1);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      expect(await wizard.textContent()).toContain("Matrix is installed and enabled.");
    } finally {
      await context.close();
    }
  });

  it("discards staged plugin configuration when installation is cancelled", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...pluginMethods, "config.schema", "config.set"],
      methodResponses: {
        ...pluginMethodResponses(),
        "config.schema": matrixConfigSchema,
        "plugins.list": {
          sequence: [
            initialInventory,
            inventory([...initialInventory.plugins, matrixNeedsSetup]),
            inventory([...initialInventory.plugins, matrixNeedsSetup]),
            inventory([...initialInventory.plugins, matrixNeedsSetup]),
          ],
        },
        "plugins.install": {
          ok: true,
          plugin: matrixNeedsSetup,
          restartRequired: true,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
      await page.getByRole("button", { name: "Install", exact: true }).click();

      const wizard = page.locator('openclaw-modal-dialog[label="Install Matrix"]');
      await wizard.getByRole("button", { name: "Install Matrix", exact: true }).click();
      await gateway.waitForRequest("gateway.restart.request");
      await reconnectMockGateway(page, gateway, "plugins-install-cancel-configuring");

      await expect
        .poll(() => wizard.locator(".plugin-install-wizard").getAttribute("data-stage"), {
          timeout: 5_000,
        })
        .toBe("configuring");
      await wizard.getByRole("textbox", { name: "Homeserver" }).fill("https://cancel.example");
      await wizard.getByRole("textbox", { name: "Access token" }).fill("cancel-secret");
      await wizard.getByText("Cancel", { exact: true }).click();

      await page.waitForTimeout(1_000);
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("installs and enables a no-config local plugin through the same restart-safe wizard", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.list": {
          sequence: [
            initialInventory,
            inventory([...initialInventory.plugins, localCalendarDisabled]),
            inventory([...initialInventory.plugins, localCalendarDisabled]),
            inventory([...initialInventory.plugins, localCalendarEnabled]),
          ],
        },
        "plugins.install": {
          ok: true,
          plugin: localCalendarDisabled,
          restartRequired: true,
        },
        "plugins.setEnabled": {
          ok: true,
          plugin: localCalendarEnabled,
          restartRequired: false,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins/${localOnlyDiscoveryPlugin.id}`);
      await page.getByRole("heading", { level: 1, name: "Local Calendar", exact: true }).waitFor();
      await page.getByRole("button", { name: "Install", exact: true }).click();

      const wizard = page.locator('openclaw-modal-dialog[label="Install Local Calendar"]');
      await wizard.getByText("Official · local-calendar", { exact: true }).waitFor();
      await wizard.getByRole("button", { name: "Install Local Calendar", exact: true }).click();
      expect((await gateway.waitForRequest("plugins.install")).params).toEqual({
        source: "official",
        pluginId: "local-calendar",
      });

      await reconnectMockGateway(page, gateway, "plugins-local-installed");
      await gateway.waitForRequest("plugins.setEnabled");
      await wizard.getByText("Plugin ready", { exact: true }).waitFor();
      expect(await wizard.textContent()).not.toContain("Complete the required settings");
      expect(await wizard.textContent()).toContain("Local Calendar is installed and enabled.");
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
      await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      const wizard = page.locator('openclaw-modal-dialog[label="Install Matrix"]');
      await wizard.getByRole("button", { name: "Install Matrix", exact: true }).click();
      await wizard.getByRole("alert").getByText("Installation did not complete").waitFor();
      expect(await wizard.getByRole("alert").textContent()).toContain(
        "ClawHub package download failed; check the network and retry.",
      );

      await wizard.getByRole("button", { name: "Try again", exact: true }).click();
      await wizard.getByRole("button", { name: "Install Matrix", exact: true }).click();
      await expect.poll(async () => (await gateway.getRequests("plugins.install")).length).toBe(2);
    } finally {
      await context.close();
    }
  });

  it("turns a stalled Gateway restart into an actionable retry", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.list": {
          sequence: [initialInventory, inventory([...initialInventory.plugins, matrixEnabled])],
        },
        "plugins.install": {
          ok: true,
          plugin: matrixNeedsSetup,
          restartRequired: true,
        },
        "gateway.restart.request": { ok: true, status: "deferred" },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
      await page.clock.install();
      await page.getByRole("button", { name: "Install", exact: true }).click();
      const wizard = page.locator('openclaw-modal-dialog[label="Install Matrix"]');
      await wizard.getByRole("button", { name: "Install Matrix", exact: true }).click();
      await expect
        .poll(() => wizard.locator(".plugin-install-wizard").getAttribute("data-stage"))
        .toBe("reconnecting");

      await page.clock.runFor(30_000);
      await wizard.getByText("Installation did not complete", { exact: true }).waitFor();
      expect(await wizard.getByRole("alert").textContent()).toContain(
        "The Gateway did not reconnect after installation. Check the Gateway status, then retry.",
      );
      expect(await wizard.getByRole("button", { name: "Try again", exact: true }).count()).toBe(1);

      const restartCount = (await gateway.getRequests("gateway.restart.request")).length;
      await gateway.deferNext("gateway.restart.request");
      await wizard.getByRole("button", { name: "Try again", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("gateway.restart.request")).length)
        .toBe(restartCount + 1);
      expect(await wizard.locator(".plugin-install-wizard").getAttribute("data-stage")).toBe(
        "reconnecting",
      );
      expect(await wizard.getByText("Plugin ready", { exact: true }).count()).toBe(0);

      await gateway.resolveDeferred("gateway.restart.request", { ok: true, status: "deferred" });
      await page.clock.runFor(0);
      await page.clock.resume();
      await reconnectMockGateway(page, gateway, "plugins-stalled-restart-recovered");
      await expect
        .poll(() => wizard.locator(".plugin-install-wizard").getAttribute("data-stage"), {
          timeout: 5_000,
        })
        .toBe("success");
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
        .locator("wa-tab-group.plugin-catalog-detail__tabs")
        .getByRole("tab", { name: "Skills" })
        .click();
      expect(await page.getByText("Calendar planning", { exact: true }).count()).toBe(1);
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

      let requestCount = (await gateway.getRequests("plugins.catalog.browse")).length;
      await explore.getByRole("button", { name: "Channels", exact: true }).click();
      const categoryRequest = await gateway.waitForRequest("plugins.catalog.browse", {
        after: requestCount,
      });
      expect(categoryRequest.params).toEqual({
        intent: "all",
        category: "channels",
        pageSize: 100,
      });
      expect(await explore.locator(".plugin-catalog-section").count()).toBe(0);
      await explore.getByRole("link", { name: "Matrix", exact: true }).waitFor();

      const search = explore.getByRole("searchbox", { name: "Search plugins" });
      requestCount = (await gateway.getRequests("plugins.catalog.browse")).length;
      await search.fill("matrix");
      const searchRequest = await gateway.waitForRequest("plugins.catalog.browse", {
        after: requestCount,
      });
      expect(searchRequest.params).toEqual({ intent: "all", query: "matrix", pageSize: 100 });
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

  it("keeps every Uncategorized card visible at the mobile shelf limit", async () => {
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
    await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.catalog.browse": { items: uncategorized },
      },
    });

    try {
      await page.goto(`${server.baseUrl}plugins`);
      const explore = page.getByRole("region", { name: "Explore plugins" });
      const featured = explore.locator('[data-catalog-section="featured"]');
      const unmatched = explore.locator('[data-catalog-section="uncategorized"]');
      await unmatched.getByRole("link", { name: "Uncategorized 3" }).waitFor();

      const visibleCardCount = async (selector: string) =>
        page
          .locator(selector)
          .evaluateAll(
            (cards) => cards.filter((card) => getComputedStyle(card).display !== "none").length,
          );
      expect(await visibleCardCount('[data-catalog-section="featured"] .plugin-catalog-card')).toBe(
        2,
      );
      expect(
        await visibleCardCount('[data-catalog-section="uncategorized"] .plugin-catalog-card'),
      ).toBe(3);
      expect(await featured.getByRole("button", { name: "View all" }).count()).toBe(1);
      expect(await unmatched.getByRole("button", { name: "View all" }).count()).toBe(0);
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
      expect(new URL(page.url()).pathname).toBe("/plugins");
      expect(await gateway.getRequests("plugins.setEnabled")).toEqual([]);
      expect(await gateway.getRequests("plugins.install")).toEqual([]);
      await page.goto(`${server.baseUrl}plugins/${matrixDiscoveryPlugin.id}`);
      const install = page.getByRole("button", { name: "Install", exact: true });
      await install.waitFor();
      expect(await install.getAttribute("aria-disabled")).toBe("true");
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
      await page.getByText("No ClawHub plugins match this view.", { exact: true }).waitFor();
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
