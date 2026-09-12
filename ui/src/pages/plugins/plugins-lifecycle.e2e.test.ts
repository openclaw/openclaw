import { afterAll, beforeAll, expect, it } from "vitest";
import { buildCapabilityConsentErrorDetails } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
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
      await page.goto(`${server.baseUrl}settings/plugins/workboard#lifecycle`);
      const toggle = page.getByRole("switch", { name: "Enable or disable Workboard", exact: true });
      await toggle.waitFor();
      await gateway.waitForRequest("config.get");
      const connects = (await gateway.getRequests("connect")).length;
      for (const [index, enabled] of [true, false, true].entries()) {
        const plugin = enabled ? workboardEnabled : workboardDisabled;
        const writes = (await gateway.getRequests("plugins.setEnabled")).length;
        const configReads = (await gateway.getRequests("config.get")).length;
        const listReads = (await gateway.getRequests("plugins.list")).length;
        await gateway.deferNext("plugins.setEnabled");
        await expect.poll(() => toggle.isEnabled()).toBe(true);
        await page
          .locator("wa-switch.settings-toggle")
          .filter({ hasText: "Enable or disable Workboard" })
          .click();
        expect(
          (await gateway.waitForRequest("plugins.setEnabled", { after: writes })).params,
        ).toEqual({
          pluginId: "workboard",
          enabled,
        });
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
        const snapshot = inventory([plugin], index + 1);
        await gateway.setMethodResponse("plugins.list", snapshot);
        await gateway.resolveDeferred("plugins.list", snapshot);
        await expect.poll(() => toggle.isChecked()).toBe(enabled);
        await page
          .locator('.plugins-row-message[role="status"]')
          .getByText(`${enabled ? "Enabled" : "Disabled"} Workboard.`, { exact: true })
          .waitFor();
        const descriptors = {
          ...enabledWorkboardCapabilities(),
          generation: index + 1,
          controlUiTabs: enabled ? enabledWorkboardCapabilities().controlUiTabs : [],
        };
        await gateway.setMethodResponse("plugins.uiDescriptors", descriptors);
        const reads = (await gateway.getRequests("plugins.uiDescriptors")).length;
        await gateway.emitGatewayEvent("plugins.changed", { generation: index + 1 });
        await gateway.waitForRequest("plugins.uiDescriptors", { after: reads });
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

  it("reviews staged capabilities and supports uninstalling and reinstalling on the same connection", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });
    try {
      await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      const wizard = page.locator('openclaw-modal-dialog[label="Install Calendar Plus"]');
      await wizard.waitFor();
      expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
      await wizard.locator("footer").getByRole("button", { name: "Cancel", exact: true }).click();
      await wizard.waitFor({ state: "detached" });
      expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      const connects = (await gateway.getRequests("connect")).length;
      await gateway.deferNext("plugins.install");
      await wizard.getByRole("button", { name: "Install Calendar Plus", exact: true }).click();
      expect((await gateway.waitForRequest("plugins.install")).params).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
      });
      expect(await page.locator("[data-plugin-consent]").count()).toBe(0);
      await gateway.rejectDeferred("plugins.install", {
        code: "INVALID_REQUEST",
        message: "Capability consent required",
        details: buildCapabilityConsentErrorDetails({
          pluginId: "calendar-plus",
          reviewToken: calendarInspection.reviewToken,
        }),
      });
      const consent = page.locator('[data-plugin-consent="install"]');
      await consent.getByText("calendar_create", { exact: true }).waitFor();
      await captureScreenshot(page, "artifact-consent-desktop.png");
      await gateway.deferNext("plugins.install");
      await consent.getByRole("button", { name: "Install Calendar Plus", exact: true }).click();
      expect((await gateway.waitForRequest("plugins.install", { after: 1 })).params).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
        acknowledgeCapabilities: { reviewToken: calendarInspection.reviewToken },
      });
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([...initialInventory.plugins, calendarPlugin]),
      );
      await gateway.resolveDeferred("plugins.install", {
        ok: true,
        plugin: calendarPlugin,
        restartRequired: false,
      });
      await wizard.getByText("Plugin ready", { exact: true }).waitFor();
      expect(await gateway.getRequests("plugins.install")).toHaveLength(2);
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
      await wizard.getByRole("button", { name: "Manage plugin", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins/calendar-plus");
      await expect
        .poll(() =>
          page
            .getByRole("switch", { name: "Enable or disable Calendar Plus", exact: true })
            .isChecked(),
        )
        .toBe(true);
      await page.getByRole("tab", { name: "Lifecycle", exact: true }).click();
      await gateway.deferNext("plugins.uninstall");
      await page.getByRole("button", { name: "Uninstall Calendar Plus", exact: true }).click();
      await page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Remove", exact: true })
        .click();
      expect((await gateway.waitForRequest("plugins.uninstall")).params).toEqual({
        pluginId: "calendar-plus",
      });
      await gateway.setMethodResponse("plugins.list", initialInventory);
      await gateway.resolveDeferred("plugins.uninstall");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/plugins");
      await page.locator(".plugins-settings-row").first().waitFor();
      expect(await page.locator('[data-plugin-id="calendar-plus"]').count()).toBe(0);
      // Browser Back returns to the catalog route retained by Manage plugin.
      await page.goBack();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(`/plugins/${calendarDiscoveryPlugin.id}`);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await gateway.deferNext("plugins.install");
      await wizard.getByRole("button", { name: "Install Calendar Plus", exact: true }).click();
      expect((await gateway.waitForRequest("plugins.install", { after: 2 })).params).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
      });
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([...initialInventory.plugins, calendarPlugin]),
      );
      await gateway.resolveDeferred("plugins.install", {
        ok: true,
        plugin: calendarPlugin,
        restartRequired: false,
      });
      await wizard.getByText("Plugin ready", { exact: true }).waitFor();
      expect(await gateway.getRequests("plugins.install")).toHaveLength(3);
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("shows a saved installation after activation fails and retries by reloading it", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });
    try {
      await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      const wizard = page.locator('openclaw-modal-dialog[label="Install Calendar Plus"]');
      const connects = (await gateway.getRequests("connect")).length;
      await gateway.deferNext("plugins.install");
      await wizard.getByRole("button", { name: "Install Calendar Plus", exact: true }).click();
      await gateway.waitForRequest("plugins.install");
      const listReads = (await gateway.getRequests("plugins.list")).length;
      const configReads = (await gateway.getRequests("config.get")).length;
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([
          ...initialInventory.plugins,
          { ...calendarPlugin, state: "error", error: "Calendar service failed to start" },
        ]),
      );
      const sourceConfig = {
        plugins: { entries: { workboard: { enabled: false }, "calendar-plus": { enabled: true } } },
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
      const failure = wizard.getByRole("alert");
      await failure.getByText("Installation did not complete", { exact: true }).waitFor();
      expect(await failure.textContent()).toContain(
        "Installation of calendar-plus was saved, but the Gateway has not applied it",
      );
      expect(await failure.textContent()).toContain("Calendar service failed to start");
      expect(await failure.textContent()).toContain("Runtime phase: activate.");
      expect(
        await wizard.getByRole("button", { name: "Install Calendar Plus", exact: true }).count(),
      ).toBe(0);
      expect(
        await wizard.getByRole("button", { name: "Continue installation", exact: true }).count(),
      ).toBe(0);
      expect(await gateway.getRequests("plugins.uiDescriptors")).toHaveLength(0);
      await captureScreenshot(page, "saved-install-runtime-failure.png");
      await gateway.deferNext("plugins.reload");
      await wizard.getByRole("button", { name: "Reload", exact: true }).click();
      expect((await gateway.waitForRequest("plugins.reload")).params).toEqual({
        plugins: [{ pluginId: "calendar-plus" }],
      });
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([...initialInventory.plugins, calendarPlugin], 2),
      );
      await gateway.resolveDeferred("plugins.reload", {
        ok: true,
        pluginIds: ["calendar-plus"],
        restartRequired: false,
        runtime: { operationId: "calendar-recovery", generation: 2, pluginIds: ["calendar-plus"] },
      });
      await wizard.getByText("Plugin ready", { exact: true }).waitFor();
      expect(await gateway.getRequests("plugins.install")).toHaveLength(1);
      expect(await gateway.getRequests("plugins.reload")).toHaveLength(1);
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("keeps structured policy findings visible through cancellation and fresh acknowledged retries", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      methodResponses: pluginMethodResponses(),
    });
    try {
      await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
      const wizard = page.locator('openclaw-modal-dialog[label="Install Calendar Plus"]');
      for (const attempt of [0, 1]) {
        await page.getByRole("button", { name: "Install", exact: true }).click();
        await gateway.deferNext("plugins.install");
        await wizard.getByRole("button", { name: "Install Calendar Plus", exact: true }).click();
        expect(
          (await gateway.waitForRequest("plugins.install", { after: attempt })).params,
        ).toEqual({ source: "clawhub", packageName: "calendar-plus" });
        await gateway.rejectDeferred("plugins.install", {
          code: "INVALID_REQUEST",
          message: "raw terminal install-policy output",
          details: { ...installPolicyWarning, targetName: "calendar-plus" },
        });
        await wizard
          .getByRole("alert")
          .getByText("ClawScan found issues to review.", { exact: true })
          .waitFor();
        expect(await wizard.getByRole("alert").textContent()).toContain("Warning");
        expect(await wizard.getByRole("alert").textContent()).toContain(
          "Semgrep found a risky command.",
        );
        expect(await wizard.textContent()).toContain(
          "approves every install-policy warning encountered during this install",
        );
        expect(await wizard.textContent()).not.toContain("raw terminal install-policy output");
        if (attempt === 0) {
          await page.setViewportSize(mobileViewport);
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) -
                  innerWidth,
              ),
            )
            .toBeLessThanOrEqual(1);
          await captureScreenshot(page, "policy-review-mobile.png");
          await wizard
            .locator("footer")
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await wizard.waitFor({ state: "detached" });
          expect(await gateway.getRequests("plugins.install")).toHaveLength(1);
        }
      }
      for (const attempt of [2, 3]) {
        await gateway.deferNext("plugins.install");
        await wizard.getByRole("button", { name: "Continue installation", exact: true }).click();
        expect(
          (await gateway.waitForRequest("plugins.install", { after: attempt })).params,
        ).toEqual({
          source: "clawhub",
          packageName: "calendar-plus",
          acknowledgeInstallPolicyWarning: true,
        });
        expect(
          await wizard.getByRole("button", { name: "Continue installation", exact: true }).count(),
        ).toBe(0);
        expect(await wizard.getByRole("alert").textContent()).toContain(
          attempt === 2
            ? "Semgrep found a risky command."
            : "The freshly checked warning changed and requires review.",
        );
        if (attempt === 2) {
          await gateway.rejectDeferred("plugins.install", {
            code: "INVALID_REQUEST",
            message: "raw dependency policy output",
            details: { ...changedInstallPolicyWarning, targetName: "calendar-plus" },
          });
          await wizard.getByRole("alert").getByText("Critical", { exact: true }).waitFor();
          expect(await wizard.textContent()).toContain(
            "The freshly checked warning changed and requires review.",
          );
          expect(await wizard.textContent()).not.toContain("raw dependency policy output");
        } else {
          await gateway.setMethodResponse(
            "plugins.list",
            inventory([...initialInventory.plugins, calendarPlugin]),
          );
          await gateway.resolveDeferred("plugins.install", {
            ok: true,
            plugin: calendarPlugin,
            restartRequired: false,
          });
        }
      }
      await wizard.getByText("Plugin ready", { exact: true }).waitFor();
      expect(await wizard.getByRole("alert").count()).toBe(0);
      expect(await gateway.getRequests("plugins.install")).toHaveLength(4);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
