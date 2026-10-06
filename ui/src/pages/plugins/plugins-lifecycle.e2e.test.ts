import { afterAll, beforeAll, expect, it } from "vitest";
import {
  calendarDiscoveryPlugin,
  calendarInspection,
  calendarPlugin,
  captureScreenshot,
  changedInstallPolicyWarning,
  configSnapshot,
  describeControlUiE2e,
  enabledWorkboardCapabilities,
  initialInventory,
  installMockGateway,
  installPolicyWarning,
  inventory,
  mobileViewport,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
  workboardDisabled,
  workboardEnabled,
} from "./plugins.e2e.test-support.ts";

describeControlUiE2e("Control UI plugin lifecycle", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("enables and disables from authoritative state and updates plugin routes without reconnecting", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });
    try {
      await page.goto(`${server.baseUrl}settings/plugins/workboard`);
      await page.getByRole("button", { name: "Enable Workboard", exact: true }).waitFor();
      await gateway.waitForRequest("config.get");
      const connects = (await gateway.getRequests("connect")).length;
      for (const [index, enabled] of [true, false, true].entries()) {
        const plugin = enabled ? workboardEnabled : workboardDisabled;
        const toggle = page.getByRole("button", {
          name: `${enabled ? "Enable" : "Disable"} Workboard`,
          exact: true,
        });
        const writes = (await gateway.getRequests("plugins.setEnabled")).length;
        const configReads = (await gateway.getRequests("config.get")).length;
        await gateway.deferNext("plugins.setEnabled");
        await expect.poll(() => toggle.isEnabled()).toBe(true);
        await toggle.click();
        expect(
          (await gateway.waitForRequest("plugins.setEnabled", { after: writes })).params,
        ).toEqual({
          pluginId: "workboard",
          enabled,
        });
        await expect.poll(() => toggle.getAttribute("aria-busy")).toBe("true");
        expect(await toggle.locator(".btn__spinner").count()).toBe(1);
        expect(await page.locator(".plugin-catalog-detail__actions .btn__spinner").count()).toBe(1);
        await captureScreenshot(page, `lifecycle-${enabled ? "enable" : "disable"}-pending.png`);
        const snapshot = inventory([plugin], index + 1);
        const descriptors = {
          ...enabledWorkboardCapabilities(),
          generation: index + 1,
          controlUiTabs: enabled ? enabledWorkboardCapabilities().controlUiTabs : [],
        };
        await gateway.setMethodResponse("plugins.list", snapshot);
        await gateway.setMethodResponse("plugins.uiDescriptors", descriptors);
        const reads = (await gateway.getRequests("plugins.uiDescriptors")).length;
        const inventoryReads = (await gateway.getRequests("plugins.list")).length;
        await gateway.emitGatewayEvent("plugins.changed", { generation: index + 1 });
        await gateway.waitForRequest("plugins.uiDescriptors", { after: reads });
        await gateway.waitForRequest("plugins.list", { after: inventoryReads });
        expect(await toggle.getAttribute("aria-busy")).toBe("true");
        expect(await toggle.isEnabled()).toBe(false);
        expect(await toggle.locator(".btn__spinner").count()).toBe(1);
        expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(writes + 1);
        const listReads = (await gateway.getRequests("plugins.list")).length;
        await gateway.deferNext("config.get");
        await gateway.deferNext("plugins.list");
        await gateway.resolveDeferred("plugins.setEnabled", {
          ok: true,
          plugin,
          restartRequired: false,
        });
        expect((await gateway.waitForRequest("config.get", { after: configReads })).params).toEqual(
          {},
        );
        await gateway.setMethodResponse("config.get", configSnapshot(enabled));
        await gateway.resolveDeferred("config.get", configSnapshot(enabled));
        expect((await gateway.waitForRequest("plugins.list", { after: listReads })).params).toEqual(
          {},
        );
        await gateway.setMethodResponse("plugins.list", snapshot);
        await gateway.resolveDeferred("plugins.list", snapshot);
        await page
          .getByRole("button", { name: `${enabled ? "Disable" : "Enable"} Workboard`, exact: true })
          .waitFor();
        expect(await page.locator(".plugins-row-message--success").count()).toBe(0);
        expect(await page.locator(".plugin-catalog-detail__actions .btn__spinner").count()).toBe(0);
      }
      await page.locator(".settings-sidebar").getByRole("button", { name: "Back to app" }).click();
      const workboardRoute = page.locator(
        'openclaw-app-sidebar .sidebar-zone-entry[data-sidebar-entry="plugin:workboard/workboard"] > .nav-item',
      );
      await workboardRoute.waitFor();
      expect(await workboardRoute.getAttribute("href")).toBe("/workboard");
      expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(3);
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it.each([
    { withWarnings: false, inspection: "before" },
    { withWarnings: true, inspection: "during" },
  ])("retains uninstall feedback through $inspection inspection", async (scenario) => {
    const { withWarnings, inspection } = scenario;
    const context = await newContext();
    const page = await context.newPage();
    const installedCalendar = { ...calendarPlugin, catalogId: calendarDiscoveryPlugin.id };
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });
    try {
      await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
      const connects = (await gateway.getRequests("connect")).length;
      await gateway.deferNext("plugins.install");
      await page.getByRole("button", { name: "Install", exact: true }).click();
      expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
      expect((await gateway.waitForRequest("plugins.install")).params).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
      });
      expect(await page.locator("[data-plugin-consent]").count()).toBe(0);
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([...initialInventory.plugins, installedCalendar]),
      );
      await gateway.resolveDeferred("plugins.install", {
        ok: true,
        plugin: installedCalendar,
        restartRequired: false,
      });
      await page.getByRole("button", { name: "Disable Calendar Plus", exact: true }).waitFor();
      expect(await page.getByText("Installed Calendar Plus.", { exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("plugins.install")).toHaveLength(1);
      expect(await page.locator("[data-plugin-consent]").count()).toBe(0);
      await captureScreenshot(page, "direct-install-desktop.png");
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(`/plugins/${calendarDiscoveryPlugin.id}`);
      await page.getByRole("button", { name: "Disable Calendar Plus", exact: true }).waitFor();
      await page
        .locator(".plugin-catalog-detail__actions")
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      await page.getByRole("searchbox", { name: "Search settings", exact: true }).waitFor();
      expect(new URL(page.url()).searchParams.get("view")).toBe("settings");
      await page
        .locator(".plugins-settings-breadcrumb")
        .getByRole("link", { name: "Calendar Plus", exact: true })
        .click();
      await page.getByRole("button", { name: "Disable Calendar Plus", exact: true }).waitFor();
      const inspectionReads = (await gateway.getRequests("plugins.inspect")).length;
      await gateway.setMethodResponse("plugins.uiDescriptors", {
        ...enabledWorkboardCapabilities(),
        generation: 17,
        controlUiTabs: [],
      });
      if (inspection === "before") {
        await gateway.deferNext("plugins.inspect");
        await gateway.emitGatewayEvent("plugins.changed", { generation: 17 });
        await gateway.waitForRequest("plugins.inspect", { after: inspectionReads });
      }
      const removalErrors = await page.evaluateHandle(() => {
        const errors = new Set<string>();
        const observer = new MutationObserver(() => {
          for (const alert of document.querySelectorAll(
            ".plugin-catalog-detail .oc-banner-error",
          )) {
            errors.add(alert.textContent?.trim() ?? "");
          }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        return { errors, observer };
      });
      await gateway.deferNext("plugins.uninstall");
      await page.getByRole("button", { name: "Uninstall Calendar Plus", exact: true }).click();
      await page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Remove", exact: true })
        .click();
      expect((await gateway.waitForRequest("plugins.uninstall")).params).toEqual({
        pluginId: "calendar-plus",
      });
      const warnings = [
        "Claw planner depends on calendar-plus. Update its plugin selection.",
        "Removed all plugin entries owned by the calendar-plus package.",
      ] as const;
      const refreshError = "Configuration reload failed after removal.";
      await gateway.deferNext("config.get");
      const removing = page.getByRole("button", { name: "Uninstall Calendar Plus", exact: true });
      await expect.poll(() => removing.getAttribute("aria-busy")).toBe("true");
      expect(await removing.locator(".btn__spinner").count()).toBe(1);
      expect(await page.locator(".plugin-catalog-detail__actions .btn__spinner").count()).toBe(1);
      await captureScreenshot(page, "lifecycle-uninstall-pending.png");
      const missingPlugin = {
        code: "INVALID_REQUEST",
        message: "Plugin 'calendar-plus' not found",
      };
      if (inspection === "before") {
        await gateway.rejectDeferred("plugins.inspect", missingPlugin);
      } else {
        const listReads = (await gateway.getRequests("plugins.list")).length;
        await gateway.setMethodResponse("plugins.inspect", { __mockError: missingPlugin });
        await gateway.emitGatewayEvent("plugins.changed", { generation: 17 });
        await gateway.waitForRequest("plugins.list", { after: listReads });
      }
      await captureScreenshot(page, `lifecycle-uninstall-inspection-${inspection}.png`);
      await gateway.setMethodResponse("plugins.list", initialInventory);
      await gateway.resolveDeferred("plugins.uninstall", {
        ok: true,
        pluginId: "calendar-plus",
        removed: ["config entry", "install record"],
        warnings: withWarnings ? warnings : [],
      });
      if (withWarnings) {
        await gateway.rejectDeferred("config.get", {
          code: "UNAVAILABLE",
          message: refreshError,
        });
      } else {
        await gateway.resolveDeferred("config.get", configSnapshot(false));
      }
      await page.getByRole("button", { name: "Install", exact: true }).waitFor();
      expect(
        await removalErrors.evaluate(({ errors, observer }) => {
          observer.disconnect();
          return [...errors];
        }),
      ).toEqual([]);
      await removalErrors.dispose();
      await gateway.setMethodResponse("plugins.inspect", {
        ...calendarInspection,
        plugin: installedCalendar,
      });
      await captureScreenshot(page, `uninstall-${withWarnings ? "warnings" : "quiet"}.png`);
      const notice = page.locator(".plugins-row-message");
      if (withWarnings) {
        await expect
          .poll(() => notice.allTextContents())
          .toEqual([expect.stringContaining(warnings[0])]);
        expect(await notice.textContent()).toContain(warnings[1]);
        expect(await notice.textContent()).toContain(refreshError);
        expect(await notice.getAttribute("class")).toContain("plugins-row-message--warning");
      } else {
        expect(await notice.count()).toBe(0);
      }
      expect(await page.getByText("Removed Calendar Plus.", { exact: true }).count()).toBe(0);
      expect(await page.locator(".plugins-row-message--success").count()).toBe(0);
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(`/plugins/${calendarDiscoveryPlugin.id}`);
      await gateway.deferNext("plugins.install");
      await page.getByRole("button", { name: "Install", exact: true }).click();
      expect((await gateway.waitForRequest("plugins.install", { after: 1 })).params).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
      });
      expect(await notice.count()).toBe(0);
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([...initialInventory.plugins, installedCalendar]),
      );
      await gateway.resolveDeferred("plugins.install", {
        ok: true,
        plugin: installedCalendar,
        restartRequired: false,
      });
      await page.getByRole("button", { name: "Disable Calendar Plus", exact: true }).waitFor();
      expect(await page.getByText("Installed Calendar Plus.", { exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("plugins.install")).toHaveLength(2);
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it.each([
    { width: 1728, height: 913 },
    { width: 390, height: 844 },
  ])(
    "retains known catalog content while installed inspection is pending at $width",
    async (viewport) => {
      const context = await newContext(viewport);
      const page = await context.newPage();
      const plugin = { ...calendarPlugin, catalogId: calendarDiscoveryPlugin.id };
      const catalog = {
        plugin: {
          ...calendarDiscoveryPlugin,
          catalog: {
            ...calendarDiscoveryPlugin.catalog,
            imageUrl: "https://icons.example/calendar.svg",
          },
        },
        detail: {
          origin: "clawhub",
          packageName: "calendar-plus",
          topics: [],
          configuration: [],
          mcpServers: [],
          skills: [],
          versions: [],
          readme: "# Calendar workflows\n\nPlan your week with the shared calendar.",
        },
      };
      const gateway = await installMockGateway(page, {
        featureMethods: pluginMethods,
        heldMethods: ["plugins.inspect"],
        methodResponses: { ...pluginMethodResponses(), "plugins.catalog.get": catalog },
      });
      await page.route("**/__openclaw__/catalog-icon/**", async (route) => {
        await route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><path fill="#f97316" d="M4 3h16v18H4z"/></svg>',
        });
      });
      try {
        await page.goto(`${server.baseUrl}plugins/${plugin.catalogId}`);
        const readme = page.getByRole("heading", { name: "Calendar workflows", exact: true });
        await readme.waitFor();
        const heroIcon = page.locator(".plugin-catalog-detail__hero img");
        await heroIcon.waitFor();
        const iconUrl = await heroIcon.getAttribute("src");
        await captureScreenshot(
          page,
          `retained-catalog-${viewport.width}-before-install.png`,
          "viewport",
        );
        await gateway.deferNext("plugins.install");
        await page.getByRole("button", { name: "Install", exact: true }).click();
        await gateway.waitForRequest("plugins.install");
        await gateway.setMethodResponse(
          "plugins.list",
          inventory([...initialInventory.plugins, plugin]),
        );
        await gateway.resolveDeferred("plugins.install", {
          ok: true,
          plugin,
          restartRequired: false,
        });
        await gateway.waitForRequest("plugins.inspect");
        await page.getByRole("button", { name: "Disable Calendar Plus", exact: true }).waitFor();
        await captureScreenshot(
          page,
          `retained-catalog-${viewport.width}-inspection-pending.png`,
          "viewport",
        );
        expect(await readme.count()).toBe(1);
        expect(await heroIcon.getAttribute("src")).toBe(iconUrl);
        await gateway.resolveDeferred("plugins.inspect", {
          ...calendarInspection,
          plugin,
          overview: { readme: "# Updated calendar workflows" },
        });
        await page
          .getByRole("heading", { name: "Updated calendar workflows", exact: true })
          .waitFor();
        expect(await readme.count()).toBe(0);
      } finally {
        await context.close();
      }
    },
  );

  it("retires failed install progress after saved installation, failed enable, and uninstall", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });
    try {
      await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
      const connects = (await gateway.getRequests("connect")).length;
      await gateway.deferNext("plugins.install");
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await gateway.waitForRequest("plugins.install");
      const listReads = (await gateway.getRequests("plugins.list")).length;
      const configReads = (await gateway.getRequests("config.get")).length;
      const failedPlugin = {
        ...calendarPlugin,
        catalogId: calendarDiscoveryPlugin.id,
        enabled: false,
        state: "error" as const,
        error: "Calendar service failed to start",
      };
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([...initialInventory.plugins, failedPlugin]),
      );
      await gateway.setMethodResponse("plugins.inspect", {
        ...calendarInspection,
        plugin: failedPlugin,
      });
      const sourceConfig = {
        plugins: {
          entries: { workboard: { enabled: false }, "calendar-plus": { enabled: false } },
        },
      };
      await gateway.setMethodResponse("config.get", {
        ...configSnapshot(false),
        config: sourceConfig,
        sourceConfig,
        resolved: sourceConfig,
        raw: JSON.stringify(sourceConfig),
        hash: "saved-calendar-install",
      });
      await gateway.rejectDeferred("plugins.install", {
        code: "UNAVAILABLE",
        message: "Calendar service failed to start",
        details: {
          persistence: { operation: "install", pluginId: "calendar-plus" },
          runtime: {
            operationId: "calendar-install",
            generation: 1,
            pluginIds: ["calendar-plus"],
            phase: "activate",
            committed: false,
          },
        },
      });
      await gateway.waitForRequest("config.get", { after: configReads });
      await gateway.waitForRequest("plugins.list", { after: listReads });
      const failure = page.locator('.plugins-row-message[role="alert"]');
      await failure.getByText(/Installation of calendar-plus was saved/).waitFor();
      expect(await failure.textContent()).toContain("Gateway has not applied it");
      expect(await failure.textContent()).toContain("Calendar service failed to start");
      expect(await failure.textContent()).toContain("Runtime phase: activate.");
      expect(await page.getByRole("button", { name: "Install", exact: true }).count()).toBe(0);
      await captureScreenshot(page, "saved-install-runtime-failure.png");
      await gateway.deferNext("plugins.setEnabled");
      await page.getByRole("button", { name: "Enable Calendar Plus", exact: true }).click();
      await gateway.waitForRequest("plugins.setEnabled");
      await gateway.rejectDeferred("plugins.setEnabled", {
        code: "UNAVAILABLE",
        message: "Calendar enable failed",
      });
      await failure.getByText("Calendar enable failed", { exact: true }).waitFor();
      await gateway.deferNext("plugins.uninstall");
      await page.getByRole("button", { name: "Uninstall Calendar Plus", exact: true }).click();
      await page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Remove", exact: true })
        .click();
      await gateway.waitForRequest("plugins.uninstall");
      await gateway.setMethodResponse("plugins.list", initialInventory);
      await gateway.resolveDeferred("plugins.uninstall");
      const install = page.getByRole("button", { name: "Install", exact: true });
      await expect.poll(() => install.count()).toBe(1);
      await captureScreenshot(page, "failed-install-removed.png");
      await gateway.deferNext("plugins.install");
      await install.click();
      expect((await gateway.waitForRequest("plugins.install", { after: 1 })).params).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
      });
      const reinstalled = { ...calendarPlugin, catalogId: calendarDiscoveryPlugin.id };
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([...initialInventory.plugins, reinstalled]),
      );
      await gateway.setMethodResponse("plugins.inspect", {
        ...calendarInspection,
        plugin: reinstalled,
      });
      await gateway.resolveDeferred("plugins.install", {
        ok: true,
        plugin: reinstalled,
        restartRequired: false,
      });
      await page.getByRole("button", { name: "Disable Calendar Plus", exact: true }).waitFor();
      expect(await gateway.getRequests("plugins.install")).toHaveLength(2);
      expect(await gateway.getRequests("plugins.reload")).toHaveLength(0);
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("keeps server policy findings visible until each warning is explicitly acknowledged", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });
    try {
      await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
      await gateway.deferNext("plugins.install");
      await page.getByRole("button", { name: "Install", exact: true }).click();
      expect((await gateway.waitForRequest("plugins.install")).params).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
      });
      await gateway.rejectDeferred("plugins.install", {
        code: "INVALID_REQUEST",
        message: "raw terminal install-policy output",
        details: { ...installPolicyWarning, targetName: "calendar-plus" },
      });
      const warning = page.locator('.plugins-row-message[role="alert"]');
      await warning.getByText("Semgrep found a risky command.", { exact: true }).waitFor();
      expect(await warning.textContent()).toContain(
        "approves every install-policy warning encountered during this install",
      );
      expect(await warning.textContent()).not.toContain("raw terminal");
      await page.setViewportSize(mobileViewport);
      await captureScreenshot(page, "policy-review-mobile.png");
      for (const attempt of [1, 2]) {
        await gateway.deferNext("plugins.install");
        await warning.getByRole("button", { name: "Continue installation", exact: true }).click();
        expect(
          (await gateway.waitForRequest("plugins.install", { after: attempt })).params,
        ).toEqual({
          source: "clawhub",
          packageName: "calendar-plus",
          acknowledgeInstallPolicyWarning: true,
        });
        expect(
          await warning
            .getByRole("button", { name: "Continue installation", exact: true })
            .isDisabled(),
        ).toBe(true);
        if (attempt === 1) {
          await gateway.rejectDeferred("plugins.install", {
            code: "INVALID_REQUEST",
            message: "raw dependency policy output",
            details: { ...changedInstallPolicyWarning, targetName: "calendar-plus" },
          });
          await warning.getByText("Critical", { exact: true }).waitFor();
          expect(await warning.textContent()).toContain(
            "The freshly checked warning changed and requires review.",
          );
          expect(await warning.textContent()).not.toContain("raw dependency");
        } else {
          const installed = { ...calendarPlugin, catalogId: calendarDiscoveryPlugin.id };
          await gateway.setMethodResponse(
            "plugins.list",
            inventory([...initialInventory.plugins, installed]),
          );
          await gateway.resolveDeferred("plugins.install", {
            ok: true,
            plugin: installed,
            restartRequired: false,
          });
        }
      }
      await page.getByRole("button", { name: "Disable Calendar Plus", exact: true }).waitFor();
      expect(await warning.count()).toBe(0);
      expect(await gateway.getRequests("plugins.install")).toHaveLength(3);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
