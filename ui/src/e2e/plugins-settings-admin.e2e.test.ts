// Control UI tests cover the canonical installed-plugin administration surface.
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import type {
  PluginCatalogItem,
  PluginListResult,
  PluginsInspectResult,
} from "../lib/plugins/index.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI plugin settings administration mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("plugin-settings-admin");
  }
});

const pluginMethods = [
  "config.get",
  "config.schema",
  "config.set",
  "plugins.inspect",
  "plugins.list",
  "plugins.setEnabled",
  "plugins.uninstall",
];

const workboard = {
  id: "workboard",
  name: "Workboard",
  packageName: "@openclaw/workboard",
  description: "Plan and track agent-owned work.",
  version: "1.2.3",
  kind: ["productivity"],
  origin: "global",
  installed: true,
  enabled: true,
  state: "enabled",
  removable: true,
} satisfies PluginCatalogItem;

const calendar = {
  id: "calendar",
  name: "Calendar",
  packageName: "@openclaw/calendar",
  description: "Coordinate schedules and events.",
  kind: ["productivity"],
  origin: "bundled",
  installed: true,
  enabled: false,
  state: "needs-setup",
  removable: false,
} satisfies PluginCatalogItem;

const brokenPlugin = {
  id: "broken-plugin",
  name: "Broken plugin",
  description: "Demonstrates plugin diagnostics.",
  origin: "global",
  installed: true,
  enabled: false,
  state: "error",
  error: "Dependency check failed. Reinstall the plugin and restart OpenClaw.",
  removable: true,
} satisfies PluginCatalogItem;

const inventory = {
  plugins: [workboard, calendar],
  diagnostics: [],
  mutationAllowed: true,
} satisfies PluginListResult;

const inspection = {
  ok: true,
  reviewToken: "a".repeat(64),
  plugin: {
    id: workboard.id,
    name: workboard.name,
    version: workboard.version,
    origin: workboard.origin,
    installed: true,
    enabled: true,
  },
  source: { kind: "npm", packageName: workboard.packageName },
  declared: {
    channels: [],
    providers: [],
    tools: ["workboard_list"],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  },
  components: {
    mapped: ["skills", "mcpServers"],
    skills: ["Weekly planning"],
    mcpServers: ["workboard"],
    commands: [],
    hooks: [],
    lspServers: [],
    unavailable: { capabilities: [], mcpServers: [], lspServers: [] },
  },
  catalog: {
    plugin: {
      id: "ch_workboard",
      catalog: {
        name: "Workboard",
        summary: "Plan and track agent-owned work.",
        author: "openclaw",
        official: true,
        categories: ["tools"],
        latestVersion: "1.2.3",
        downloads: 1200,
      },
      local: {
        present: true,
        installed: true,
        enabled: true,
        state: "enabled",
        pluginId: "workboard",
        action: "manage",
      },
    },
    detail: {
      origin: "clawhub",
      packageName: "@openclaw/workboard",
      author: { handle: "openclaw", displayName: "OpenClaw" },
      topics: ["planning"],
      updatedAt: 1_788_000_000_000,
      readme: "# Workboard\n\nCoordinate agent work in one place.",
      compatibility: { minGatewayVersion: ">=1.0.0" },
      configuration: [],
      mcpServers: ["workboard"],
      skills: [{ name: "Weekly planning" }],
      versions: [
        { version: "1.2.3", createdAt: 1_788_000_000_000, changelog: "", tags: ["latest"] },
      ],
      security: { status: "clean" },
    },
  },
  grants: {
    hooks: {
      allowPromptInjection: { effective: true, configured: true },
      allowConversationAccess: { effective: false, configured: false },
    },
  },
} satisfies PluginsInspectResult;

const config = {
  plugins: {
    enabled: true,
    allow: ["workboard"],
    deny: ["legacy-plugin"],
    load: { paths: ["/opt/openclaw/plugins"] },
    entries: {
      workboard: {
        enabled: true,
        config: {
          workspaceLabel: "Planning",
          refreshMinutes: 15,
        },
      },
    },
  },
};

const configMocks = {
  "config.get": {
    appliedConfigHash: "plugins-settings-e2e",
    config,
    hash: "plugins-settings-e2e",
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  },
  "config.schema": {
    generatedAt: "2026-09-01T00:00:00.000Z",
    schema: {
      type: "object",
      properties: {
        plugins: {
          type: "object",
          title: "Plugins",
          properties: {
            enabled: { type: "boolean", title: "Plugin system enabled" },
            allow: {
              type: "array",
              title: "Allowed plugin IDs",
              items: { type: "string" },
            },
            deny: {
              type: "array",
              title: "Blocked plugin IDs",
              items: { type: "string" },
            },
            load: {
              type: "object",
              title: "Plugin loading",
              properties: {
                paths: {
                  type: "array",
                  title: "Additional plugin load paths",
                  items: { type: "string" },
                },
              },
            },
            entries: {
              type: "object",
              title: "Plugin entries",
              properties: {
                workboard: {
                  type: "object",
                  title: "Workboard",
                  properties: {
                    enabled: { type: "boolean", title: "Enabled" },
                    config: {
                      type: "object",
                      title: "Configuration",
                      properties: {
                        workspaceLabel: { type: "string", title: "Workspace label" },
                        refreshMinutes: {
                          type: "integer",
                          title: "Refresh interval (minutes)",
                          minimum: 1,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    uiHints: {
      "plugins.enabled": { advanced: true },
      "plugins.allow": { advanced: true },
      "plugins.deny": { advanced: true },
      "plugins.load.paths": { advanced: true },
      "plugins.entries.workboard.config.workspaceLabel": { advanced: false },
      "plugins.entries.workboard.config.refreshMinutes": { advanced: false },
    },
    version: "e2e",
  },
};

function pluginResponses() {
  return {
    ...configMocks,
    "plugins.inspect": inspection,
    "plugins.list": inventory,
    "plugins.setEnabled": {
      ok: true,
      plugin: { ...workboard, enabled: false, state: "disabled" },
      restartRequired: false,
    },
    "plugins.uninstall": {
      ok: true,
      pluginId: workboard.id,
      removed: ["config entry", "install record"],
      restartRequired: true,
    },
  };
}

async function openWorkboard(page: Parameters<typeof waitForControlUiRoute>[0], baseUrl: string) {
  const response = await page.goto(`${baseUrl}settings/plugins`);
  expect(response?.status()).toBe(200);
  await waitForControlUiRoute(page, {
    pathname: "/settings/plugins",
    routeId: "plugin-settings",
  });

  await page.getByRole("heading", { level: 1, name: "Plugins", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Installed", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Advanced", exact: true }).waitFor();
  const search = page.getByRole("searchbox", { name: "Search installed plugins", exact: true });
  await search.waitFor();
  const inventoryGeometry = await page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(".settings-page.oc-app-surface");
    const title = surface?.querySelector<HTMLElement>(".plugins-settings-title");
    const tabs = surface?.querySelector<HTMLElement>(".plugins-settings-tabs.oc-segmented");
    const searchField = surface?.querySelector<HTMLElement>(".plugins-settings-search");
    const section = surface?.querySelector<HTMLElement>(".settings-section");
    if (!surface || !title || !tabs || !searchField || !section) {
      return null;
    }
    const surfaceRect = surface.getBoundingClientRect();
    const titleRect = title.getBoundingClientRect();
    const tabsRect = tabs.getBoundingClientRect();
    const searchRect = searchField.getBoundingClientRect();
    const sectionRect = section.getBoundingClientRect();
    return {
      titleLeft: titleRect.left,
      searchLeft: searchRect.left,
      sectionLeft: sectionRect.left,
      surfaceWidth: surfaceRect.width,
      tabsWidth: tabsRect.width,
      tabsToSearch: searchRect.top - tabsRect.bottom,
      searchToSection: sectionRect.top - searchRect.bottom,
    };
  });
  expect(inventoryGeometry).not.toBeNull();
  expect(inventoryGeometry?.tabsWidth ?? Infinity).toBeLessThan(
    (inventoryGeometry?.surfaceWidth ?? 0) / 2,
  );
  expect(
    Math.abs((inventoryGeometry?.titleLeft ?? 0) - (inventoryGeometry?.searchLeft ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs((inventoryGeometry?.searchLeft ?? 0) - (inventoryGeometry?.sectionLeft ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(inventoryGeometry?.tabsToSearch ?? 0).toBeGreaterThan(0);
  expect(inventoryGeometry?.searchToSection ?? 0).toBeGreaterThan(0);
  expect(
    Math.abs(
      (inventoryGeometry?.tabsToSearch ?? Infinity) -
        (inventoryGeometry?.searchToSection ?? -Infinity),
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    await page
      .locator("#plugin-settings-panel article[data-plugin-id]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-plugin-id"))),
  ).toEqual(["calendar", "workboard"]);
  await search.fill("calendar");
  await page.locator('[data-plugin-id="calendar"]').waitFor();
  await expect.poll(() => page.locator('[data-plugin-id="workboard"]').count()).toBe(0);
  await search.clear();

  const workboardRow = page.locator('[data-plugin-id="workboard"]');
  await workboardRow.waitFor();
  const workboardLink = workboardRow.getByRole("link", { name: /Workboard/iu });
  expect(await workboardLink.getAttribute("href")).toBe("/settings/plugins/workboard");
  const enabledStatus = workboardRow.locator('.settings-status[data-plugin-state="enabled"]');
  expect(await enabledStatus.count()).toBe(1);
  expect(await enabledStatus.getAttribute("title")).toBe("Enabled");
  expect(await workboardRow.getByRole("switch").count()).toBe(0);
  await page.locator(".settings-page.oc-app-surface").waitFor();
  if (captureUiProof) {
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: path.join(proofDir, "01-installed-inventory.png"),
    });
  }
  await workboardLink.click();
  await waitForControlUiRoute(page, {
    pathname: "/settings/plugins/workboard",
    routeId: "plugin-settings",
  });
}

suite.define(() => {
  it("moves needs-setup guidance into the Configuration tab", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const needsSetup = { ...workboard, enabled: false, state: "needs-setup" as const };
        const localInspection = {
          ...inspection,
          catalog: undefined,
          components: {
            mapped: ["commands"],
            skills: [],
            mcpServers: [],
            commands: [],
            hooks: [],
            lspServers: [],
            unavailable: {
              capabilities: ["agents", "hooks", "rules"],
              mcpServers: [],
              lspServers: [],
            },
          },
        };
        await installMockGateway(page, {
          featureMethods: pluginMethods,
          methodResponses: {
            ...pluginResponses(),
            "plugins.list": { ...inventory, plugins: [needsSetup] },
            "plugins.inspect": {
              ...localInspection,
              plugin: { ...localInspection.plugin, enabled: false },
            },
          },
          operatorScopes: ["operator.read", "operator.admin"],
        });

        await page.goto(`${suite.server.baseUrl}settings/plugins/workboard`);
        const configuration = page.getByRole("tab", { name: /Configuration/iu });
        await configuration.waitFor();
        expect(await page.locator(".plugin-catalog-detail--no-sidebar").count()).toBe(1);
        expect(await page.locator(".plugin-catalog-detail__sidebar").count()).toBe(0);
        expect(await page.getByRole("tab", { name: "Commands", exact: true }).count()).toBe(0);
        expect(await page.getByRole("tab", { name: "Hooks", exact: true }).count()).toBe(0);
        const dot = configuration.locator(".plugin-installed-detail__setup-dot");
        expect(await dot.getAttribute("title")).toBe(
          "This plugin requires additional configuration",
        );
        expect(await page.getByText("Setup required", { exact: true }).count()).toBe(0);
        await configuration.click();
        await page
          .getByText("Complete the required configuration before enabling this plugin.", {
            exact: true,
          })
          .waitFor();
      },
    );
  });

  it("drills from searchable inventory into the shared tabbed detail shell", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: pluginMethods,
          methodResponses: pluginResponses(),
          operatorScopes: ["operator.read", "operator.admin"],
        });

        await openWorkboard(page, suite.server.baseUrl);
        await page.getByRole("heading", { level: 1, name: "Workboard", exact: true }).waitFor();
        await page.getByRole("link", { name: "Settings", exact: true }).waitFor();
        await page.getByText("Plan and track agent-owned work.", { exact: true }).waitFor();
        await page.getByRole("link", { name: "View on ClawHub", exact: true }).waitFor();
        const securityAudit = page.getByRole("link", { name: /Security audit/iu });
        expect(await securityAudit.getAttribute("href")).toBe(
          "https://clawhub.ai/openclaw/plugins/workboard/security-audit",
        );
        expect(await securityAudit.getAttribute("class")).toContain(
          "plugin-catalog-detail__security--pass",
        );
        expect(await securityAudit.getByText("Pass", { exact: true }).count()).toBe(1);
        expect(
          await securityAudit.locator(".plugin-catalog-detail__security-score > span").count(),
        ).toBe(3);
        expect(await securityAudit.getByText("clean", { exact: true }).count()).toBe(0);
        expect(
          await page
            .getByRole("tab")
            .evaluateAll((tabs) => tabs.map((tab) => tab.textContent?.trim()).filter(Boolean)),
        ).toEqual([
          "README",
          "Configuration",
          "Skills",
          "MCP servers",
          "Compatibility",
          "Versions",
          "Access",
          "Lifecycle",
          "Advanced",
        ]);
        await page.getByRole("tab", { name: "Configuration", exact: true }).click();
        const refresh = page.getByRole("button", { name: "Reload", exact: true });
        await refresh.waitFor();
        expect((await refresh.textContent())?.trim()).toBe("");
        expect(await refresh.getAttribute("title")).toBeNull();
        expect(await gateway.getRequests("plugins.inspect")).toHaveLength(1);

        await page.getByRole("tab", { name: "Access", exact: true }).click();
        await page.getByText("Add context to prompts", { exact: true }).waitFor();
        await page.getByText("Read conversation context", { exact: true }).waitFor();
        expect(await page.getByText("workboard_list", { exact: true }).count()).toBe(0);
        await page.getByRole("tab", { name: "Advanced", exact: true }).click();
        await page.getByText("workboard_list", { exact: true }).waitFor();
        await page.getByRole("tab", { name: "Lifecycle", exact: true }).click();
        await page.locator("code").filter({ hasText: "@openclaw/workboard" }).first().waitFor();
        await page.getByText("v1.2.3", { exact: true }).waitFor();
        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(proofDir, "02-plugin-detail.png"),
          });
        }
        await page.reload();
        await waitForControlUiRoute(page, {
          pathname: "/settings/plugins/workboard",
          routeId: "plugin-settings",
        });
        await page.locator("code").filter({ hasText: "@openclaw/workboard" }).first().waitFor();
        await page.getByRole("link", { name: "Settings", exact: true }).click();
        await waitForControlUiRoute(page, {
          pathname: "/settings/plugins",
          routeId: "plugin-settings",
        });
      },
    );
  });

  it("shows the diagnostic and next step for an errored installed plugin", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          featureMethods: pluginMethods,
          methodResponses: {
            ...pluginResponses(),
            "plugins.list": { ...inventory, plugins: [brokenPlugin] },
            "plugins.inspect": {
              ...inspection,
              plugin: {
                ...inspection.plugin,
                id: brokenPlugin.id,
                name: brokenPlugin.name,
                enabled: false,
              },
            },
          },
          operatorScopes: ["operator.read", "operator.admin"],
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/plugins/broken-plugin`);
        expect(response?.status()).toBe(200);
        await waitForControlUiRoute(page, {
          pathname: "/settings/plugins/broken-plugin",
          routeId: "plugin-settings",
        });

        await page.getByRole("heading", { level: 1, name: "Broken plugin", exact: true }).waitFor();
        await page.getByText("Needs attention", { exact: true }).waitFor();
        await page
          .getByRole("alert")
          .filter({
            hasText: "Dependency check failed. Reinstall the plugin and restart OpenClaw.",
          })
          .waitFor();
        expect(await page.getByRole("tab", { name: "Configuration", exact: true }).count()).toBe(0);
        expect(await page.getByRole("button", { name: "Reload", exact: true }).count()).toBe(0);
        expect(await page.getByText("This plugin has no configurable settings.").count()).toBe(0);
        await page.getByRole("tab", { name: "Access", exact: true }).waitFor();
        await page.getByRole("tab", { name: "Lifecycle", exact: true }).waitFor();
      },
    );
  });

  it("saves schema-backed plugin configuration and reports lifecycle outcomes", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: pluginMethods,
          methodResponses: pluginResponses(),
          operatorScopes: ["operator.read", "operator.admin"],
        });
        await openWorkboard(page, suite.server.baseUrl);

        const toggle = page.locator("wa-switch").filter({ hasText: "Enable or disable Workboard" });
        await toggle.click();
        await gateway.waitForRequest("plugins.setEnabled");
        await page.getByRole("status").filter({ hasText: "Disabled Workboard." }).waitFor();
        expect(
          await page
            .locator(".plugins-row-message")
            .filter({ hasText: "Disabled Workboard." })
            .count(),
        ).toBe(1);

        await page.getByRole("tab", { name: "Configuration", exact: true }).click();
        const workspace = page.getByLabel("Workspace label", { exact: true });
        const catalogRequests = (await gateway.getRequests("plugins.list")).length;
        await workspace.fill("Release planning");
        const save = await gateway.waitForRequest("config.set");
        expect(save.params).toMatchObject({ baseHash: "plugins-settings-e2e" });
        const savedConfig = JSON.parse(
          String((save.params as { raw?: unknown }).raw),
        ) as typeof config;
        expect(savedConfig.plugins.entries.workboard.config).toMatchObject({
          refreshMinutes: 15,
          workspaceLabel: "Release planning",
        });
        await expect
          .poll(async () => (await gateway.getRequests("plugins.list")).length)
          .toBe(catalogRequests + 1);
        expect(
          await page.getByRole("button", { name: "Save configuration", exact: true }).count(),
        ).toBe(0);

        const uninstallCount = (await gateway.getRequests("plugins.uninstall")).length;
        await page.getByRole("tab", { name: "Lifecycle", exact: true }).click();
        await page.getByRole("button", { name: /(?:Remove|Uninstall) Workboard/iu }).click();
        await page.getByRole("dialog").waitFor();
        await page
          .locator(".exec-approval-actions")
          .getByRole("button", { name: "Remove", exact: true })
          .click();
        await gateway.waitForRequest("plugins.uninstall", { after: uninstallCount });
        await page
          .getByRole("status")
          .filter({ hasText: /removed|uninstalled/iu })
          .waitFor();
      },
    );
  });

  it("keeps global plugin policy in Advanced and exposes read-only details without mutations", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: pluginMethods,
          methodResponses: pluginResponses(),
          operatorScopes: ["operator.read"],
        });

        await page.goto(`${suite.server.baseUrl}settings/plugins`);
        await page.getByRole("tab", { name: "Advanced", exact: true }).click();
        const advancedTitles = page.locator(".settings-row__title");
        await advancedTitles.getByText("Plugin system enabled", { exact: true }).waitFor();
        await advancedTitles.getByText("Allowed plugin IDs", { exact: true }).waitFor();
        await advancedTitles.getByText("Blocked plugin IDs", { exact: true }).waitFor();
        await advancedTitles.getByText("Additional plugin load paths", { exact: true }).waitFor();
        await expect
          .poll(() =>
            page
              .locator("input")
              .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
          )
          .toEqual(expect.arrayContaining(["legacy-plugin", "/opt/openclaw/plugins"]));

        await page.getByRole("tab", { name: "Installed", exact: true }).click();
        await page.locator('[data-plugin-id="workboard"]').click();
        await waitForControlUiRoute(page, {
          pathname: "/settings/plugins/workboard",
          routeId: "plugin-settings",
        });
        expect(await page.locator(".callout.info").count()).toBe(0);
        expect(
          await page.getByRole("button", { name: "Save configuration", exact: true }).count(),
        ).toBe(0);
        const toggle = page.locator("wa-switch").filter({ hasText: "Enable or disable Workboard" });
        await page.getByRole("tab", { name: "Configuration", exact: true }).click();
        const workspace = page.getByLabel("Workspace label", { exact: true });
        expect(await workspace.isDisabled()).toBe(true);
        await page.getByRole("tab", { name: "Lifecycle", exact: true }).click();
        const uninstall = page.getByRole("button", {
          name: /(?:Remove|Uninstall) Workboard/iu,
        });
        expect(await toggle.getAttribute("aria-disabled")).toBe("true");
        expect(await uninstall.getAttribute("aria-disabled")).toBe("true");
        await toggle.dispatchEvent("click");
        await uninstall.dispatchEvent("click");
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
        expect(await gateway.getRequests("plugins.uninstall")).toHaveLength(0);
      },
    );
  });

  it("recovers catalog, configuration, and inspection failures in place", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1000, width: 1440 },
      },
      async ({ page }) => {
        const failure = (message: string) => ({
          __mockError: { code: "UNAVAILABLE", message },
        });
        const gateway = await installMockGateway(page, {
          featureMethods: pluginMethods,
          methodResponses: {
            ...configMocks,
            "config.get": failure("Configuration unavailable"),
            "plugins.inspect": {
              sequence: [failure("Inspection unavailable"), inspection],
            },
            "plugins.list": {
              sequence: [failure("Catalog unavailable"), inventory],
            },
          },
          operatorScopes: ["operator.read", "operator.admin"],
        });

        await page.goto(`${suite.server.baseUrl}settings/plugins`);
        await page.getByRole("alert").filter({ hasText: "Catalog unavailable" }).waitFor();
        const catalogRequests = (await gateway.getRequests("plugins.list")).length;
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await page.locator('[data-plugin-id="workboard"]').waitFor();
        expect(await gateway.getRequests("plugins.list")).toHaveLength(catalogRequests + 1);

        await gateway.setMethodResponse("plugins.list", failure("Catalog refresh unavailable"));
        const refreshedCatalogRequests = (await gateway.getRequests("plugins.list")).length;
        await gateway.setOnline(false);
        await gateway.setOnline(true);
        await expect
          .poll(async () => (await gateway.getRequests("plugins.list")).length)
          .toBeGreaterThan(refreshedCatalogRequests);
        await page.getByRole("alert").filter({ hasText: "Catalog refresh unavailable" }).waitFor();
        await page.locator('[data-plugin-id="workboard"]').waitFor();
        await gateway.setMethodResponse("plugins.list", inventory);

        await page.locator('[data-plugin-id="workboard"]').click();
        const inspectionError = page
          .getByRole("alert")
          .filter({ hasText: "Inspection unavailable" });
        await inspectionError.waitFor();
        await inspectionError.getByRole("button", { name: "Try again", exact: true }).click();
        await expect
          .poll(async () => (await gateway.getRequests("plugins.inspect")).length)
          .toBe(2);
        await page.getByRole("tab", { name: "README", exact: true }).waitFor();
        await page.getByRole("tab", { name: "Access", exact: true }).click();
        await expect.poll(() => new URL(page.url()).hash).toBe("#access");
        await page.getByText("Add context to prompts", { exact: true }).waitFor();

        await page.getByRole("tab", { name: "Configuration", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "Configuration unavailable" }).waitFor();
        const configRequests = (await gateway.getRequests("config.get")).length;
        await gateway.setMethodResponse("config.get", configMocks["config.get"]);
        await page.getByRole("button", { name: "Reload", exact: true }).click();
        await page.getByLabel("Workspace label", { exact: true }).waitFor();
        expect(await gateway.getRequests("config.get")).toHaveLength(configRequests + 1);
      },
    );
  });
});
