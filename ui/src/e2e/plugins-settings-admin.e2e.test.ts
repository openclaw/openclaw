// Control UI tests cover the canonical installed-plugin administration surface.
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, it } from "vitest";
import { loadPluginManifest, PLUGIN_MANIFEST_FILENAME } from "../../../src/plugins/manifest.ts";
import { resolveBundledPluginPublicModulePath } from "../../../src/test-utils/bundled-plugin-public-surface.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  workboard,
  brokenPlugin,
  inventory,
  inspection,
  config,
  configMocks,
  pluginResponses,
} from "./plugins-settings-admin.test-support.ts";

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
    const section = surface?.querySelector<HTMLElement>("#plugin-settings-panel .settings-group");
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
  it.each<{
    pluginId: string;
    name: string;
    section: string;
    label: string;
    referenceLabel: string;
    readOnly: boolean;
    pluginConfig: Record<string, Record<string, unknown>>;
  }>([
    ...[false, true].map((readOnly) => ({
      pluginId: "brave",
      name: "Brave",
      section: "webSearch",
      label: "Brave Search API Key",
      referenceLabel: "Brave Search Base URL",
      readOnly,
      pluginConfig: {
        webSearch: {
          baseUrl: { source: "env", provider: "default", id: "BRAVE_PROXY_URL" },
          mode: "web",
        },
      },
    })),
    {
      pluginId: "firecrawl",
      name: "Firecrawl",
      section: "webFetch",
      label: "Firecrawl Fetch API Key",
      referenceLabel: "Firecrawl Search API Key",
      readOnly: false,
      pluginConfig: {
        webSearch: { apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY" } },
        webFetch: { onlyMainContent: true, timeoutSeconds: 20 },
      },
    },
  ])(
    "edits $name string/object credentials and preserves settings (readOnly=$readOnly)",
    async ({ pluginId, name, section, label, referenceLabel, readOnly, pluginConfig }) => {
      const manifestResult = loadPluginManifest(
        path.dirname(
          resolveBundledPluginPublicModulePath({
            pluginId,
            artifactBasename: PLUGIN_MANIFEST_FILENAME,
          }),
        ),
      );
      if (!manifestResult.ok) {
        throw new Error(manifestResult.error);
      }
      const { manifest } = manifestResult;
      const uiHints = manifest.uiHints;
      if (!uiHints) {
        throw new Error(`Expected credential UI hints for ${pluginId}`);
      }
      await suite.withPage(
        {
          colorScheme: "dark",
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 1000, width: 1440 },
        },
        async ({ page }) => {
          const credentialConfig = {
            ...config,
            plugins: {
              ...config.plugins,
              entries: {
                ...config.plugins.entries,
                [manifest.id]: { enabled: true, config: pluginConfig },
              },
            },
          };
          const gateway = await installMockGateway(page, {
            featureMethods: pluginMethods,
            operatorScopes: readOnly ? ["operator.read"] : ["operator.read", "operator.admin"],
            methodResponses: {
              ...pluginResponses(),
              "plugins.list": {
                ...inventory,
                plugins: [
                  {
                    ...workboard,
                    id: manifest.id,
                    name,
                    packageName: `@openclaw/${manifest.id}`,
                    description: `${name} web tools.`,
                    origin: "bundled",
                  },
                ],
              },
              "plugins.inspect": {
                ...inspection,
                catalog: undefined,
                components: undefined,
                source: { kind: "npm", packageName: `@openclaw/${manifest.id}` },
                plugin: { ...inspection.plugin, id: manifest.id, name, origin: "bundled" },
              },
              "config.get": {
                ...configMocks["config.get"],
                config: credentialConfig,
                raw: JSON.stringify(credentialConfig),
              },
              "config.schema": {
                ...configMocks["config.schema"],
                schema: {
                  type: "object",
                  properties: {
                    plugins: {
                      type: "object",
                      properties: {
                        entries: {
                          type: "object",
                          properties: {
                            [manifest.id]: {
                              type: "object",
                              properties: { config: manifest.configSchema },
                            },
                          },
                        },
                      },
                    },
                  },
                },
                uiHints: Object.fromEntries(
                  Object.entries(uiHints).map(([key, hint]) => [
                    `plugins.entries.${manifest.id}.config.${key}`,
                    hint,
                  ]),
                ),
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}settings/plugins/${manifest.id}#configuration`);
          await page
            .locator(".plugin-editor")
            .getByRole("searchbox", { name: "Search settings", exact: true })
            .waitFor();
          const apiKey = page.locator("input").and(page.getByLabel(new RegExp(`${label}$`, "u")));
          await apiKey.waitFor();
          if (captureUiProof) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, "credential-inputs.png"),
            });
          }
          expect(await apiKey.count()).toBe(1);
          expect(await apiKey.getAttribute("type")).toBe("password");
          const reference = page
            .locator("input")
            .and(page.getByLabel(new RegExp(`${referenceLabel}$`, "u")));
          expect(await reference.inputValue()).toBe("");
          expect(await reference.getAttribute("readonly")).not.toBeNull();
          expect(await reference.getAttribute("placeholder")).not.toContain("Raw");
          expect(await apiKey.isDisabled()).toBe(readOnly);
          if (readOnly) {
            expect(await reference.isDisabled()).toBe(true);
            expect(await gateway.getRequests("config.set")).toHaveLength(0);
            return;
          }
          await apiKey.pressSequentially("synthetic-credential", { delay: 30 });
          expect(await apiKey.inputValue()).toBe("synthetic-credential");
          expect(await apiKey.getAttribute("type")).toBe("password");
          await apiKey.press("Tab");
          const save = await gateway.waitForRequest("config.set");
          expect(JSON.parse(String(asRecord(save.params).raw))).toEqual({
            ...credentialConfig,
            plugins: {
              ...credentialConfig.plugins,
              entries: {
                ...credentialConfig.plugins.entries,
                [manifest.id]: {
                  enabled: true,
                  config: {
                    ...pluginConfig,
                    [section]: { ...pluginConfig[section], apiKey: "synthetic-credential" },
                  },
                },
              },
            },
          });
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  document.querySelector<HTMLElement & { context: ApplicationContext }>(
                    "openclaw-plugins-page",
                  )?.context.runtimeConfig.state.configAutoSaveStatus,
              ),
            )
            .toBe("saved");
          await page.reload();
          await gateway.waitForRequest("config.get");
          await expect.poll(() => apiKey.inputValue()).toBe("synthetic-credential");
          expect(await reference.inputValue()).toBe("");
          expect(await reference.getAttribute("readonly")).not.toBeNull();
          if (captureUiProof) {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, "credential-reloaded.png"),
            });
          }
        },
      );
    },
  );

  it("opens settings without adding a setup alert", async () => {
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
        const configuration = page
          .locator(".plugin-catalog-detail__actions")
          .getByRole("link", { name: "Settings", exact: true });
        await configuration.waitFor();
        expect(await page.getByRole("tab").count()).toBe(0);
        expect(await page.locator(".plugin-installed-detail__setup-dot").count()).toBe(0);
        expect(await page.getByText("Setup required", { exact: true }).count()).toBe(0);
        await configuration.click();
        await page
          .locator(".plugin-editor")
          .getByRole("searchbox", { name: "Search settings", exact: true })
          .waitFor();
        expect(await page.locator(".plugin-editor .callout.warning").count()).toBe(0);
      },
    );
  });

  it("drills from searchable inventory into overview and same-URL Settings", async () => {
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
        await page
          .locator(".plugin-catalog-detail__actions")
          .getByRole("link", { name: "Settings", exact: true })
          .waitFor();
        await page.getByText("Plan and track agent-owned work.", { exact: true }).waitFor();
        expect(await page.getByRole("link", { name: "View on ClawHub", exact: true }).count()).toBe(
          0,
        );
        const securityAudit = page.getByRole("link", { name: /Security audit/iu });
        expect(await securityAudit.getAttribute("href")).toBe(
          "https://clawhub.ai/openclaw/plugins/workboard/security-audit",
        );
        expect(await securityAudit.getAttribute("class")).toContain(
          "plugin-catalog-detail__security--pass",
        );
        expect(await securityAudit.getByText("Clean", { exact: true }).count()).toBe(1);
        expect(
          await securityAudit.locator(".plugin-catalog-detail__security-score > span").count(),
        ).toBe(3);
        expect(await securityAudit.getByText("clean", { exact: true }).count()).toBe(0);
        expect(await page.getByRole("tab").count()).toBe(0);
        await page
          .locator(".plugin-catalog-detail__actions")
          .getByRole("link", { name: "Settings", exact: true })
          .click();
        await page
          .getByRole("searchbox", { name: "Search settings", exact: true })
          .last()
          .waitFor();
        expect(await gateway.getRequests("plugins.inspect")).toHaveLength(1);

        await page.getByText("Add context to prompts", { exact: true }).waitFor();
        await page.getByText("Read conversation context", { exact: true }).waitFor();
        await page.getByText("workboard_list", { exact: true }).waitFor();

        await page.getByRole("link", { name: "Workboard", exact: true }).click();
        await page.getByRole("heading", { level: 1, name: "Workboard", exact: true }).waitFor();
        await page.getByText("1.2.3", { exact: true }).first().waitFor();
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
        await page.getByRole("heading", { level: 1, name: "Workboard", exact: true }).waitFor();
        await page.locator(".plugins-settings-breadcrumb__parent").click();
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
        await page
          .getByRole("alert")
          .filter({
            hasText: "Dependency check failed. Reinstall the plugin and restart OpenClaw.",
          })
          .waitFor();
        expect(
          await page
            .locator(".plugin-catalog-detail__actions")
            .getByRole("link", { name: "Settings", exact: true })
            .count(),
        ).toBe(1);
        expect(await page.getByRole("button", { name: "Reload", exact: true }).count()).toBe(0);
        expect(await page.getByText("This plugin has no configurable settings.").count()).toBe(0);
        expect(
          await page.getByRole("button", { name: "Reload Broken plugin", exact: true }).count(),
        ).toBe(0);
      },
    );
  });

  it("commits grouped plugin settings on blur and actions through the route", async () => {
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

        const toggle = page.getByRole("button", { name: "Disable Workboard", exact: true });
        const connections = (await gateway.getRequests("connect")).length;
        await toggle.click();
        await gateway.waitForRequest("plugins.setEnabled");

        await expect
          .poll(() =>
            page
              .getByRole("status")
              .filter({ hasText: "Disabled Workboard." })
              .and(page.locator(".plugins-row-message:visible"))
              .count(),
          )
          .toBe(1);
        expect(await gateway.getRequests("connect")).toHaveLength(connections);

        await page
          .locator(".plugin-catalog-detail__actions")
          .getByRole("link", { name: "Settings", exact: true })
          .click();
        const workspace = page.getByLabel("Workspace label", { exact: true });
        await workspace.waitFor();
        if (captureUiProof) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(proofDir, "grouped-settings.png"),
          });
        }
        expect(
          await page.getByRole("heading", { name: "Workboard settings", exact: true }).count(),
        ).toBe(0);
        expect(await page.locator(".plugin-editor__section > h2").allTextContents()).toEqual([
          "Workspace",
          "Updates",
          "Permissions",
        ]);
        const geometry = await page.locator('[data-setting="workspaceLabel"]').evaluate((row) => {
          const copy = row.querySelector(".plugin-editor__copy")!.getBoundingClientRect();
          const control = row.querySelector(".plugin-editor__control")!.getBoundingClientRect();
          return {
            gap: control.left - copy.right,
            top: copy.top - control.top,
            menuTop:
              row.querySelector('button[slot="trigger"]')!.getBoundingClientRect().top -
              control.top,
          };
        });
        expect(geometry.gap).toBeGreaterThanOrEqual(35);
        expect(Math.abs(geometry.top)).toBeLessThanOrEqual(1);
        expect(Math.abs(geometry.menuTop)).toBeLessThanOrEqual(1);
        if (captureUiProof) {
          for (const viewport of [
            { width: 390, height: 844 },
            { width: 768, height: 1024 },
            { width: 1366, height: 768 },
          ]) {
            await page.setViewportSize(viewport);
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, `grouped-settings-${viewport.width}.png`),
            });
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            ).toBe(true);
          }
          await page.setViewportSize({ width: 1440, height: 1000 });
        }
        const catalogRequests = (await gateway.getRequests("plugins.list")).length;
        const workspaceInspections = (await gateway.getRequests("plugins.inspect")).length;
        await workspace.fill("Release planning");
        expect(await gateway.getRequests("config.set")).toHaveLength(0);
        await workspace.press("Tab");
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

        await gateway.waitForRequest("plugins.inspect", { after: workspaceInspections });
        const checkboxInspections = (await gateway.getRequests("plugins.inspect")).length;
        await page.locator('[data-setting="notifications"] .plugin-editor__title').click();
        const checkboxSave = await gateway.waitForRequest("config.set", { after: 1 });
        expect(JSON.parse(String(asRecord(checkboxSave.params).raw))).toMatchObject({
          plugins: {
            entries: {
              workboard: {
                config: {
                  workspaceLabel: "Release planning",
                  notifications: false,
                  refreshMinutes: 15,
                },
              },
            },
          },
        });
        await gateway.waitForRequest("plugins.inspect", { after: checkboxInspections });
        const resetInspections = (await gateway.getRequests("plugins.inspect")).length;
        await page
          .getByRole("button", { name: "Actions for Workspace label", exact: true })
          .click();
        await page
          .locator('[data-setting="workspaceLabel"] wa-dropdown-item[value="reset"]')
          .click();
        const resetSave = await gateway.waitForRequest("config.set", { after: 2 });
        const resetConfig = JSON.parse(String(asRecord(resetSave.params).raw));
        expect(resetConfig.plugins.entries.workboard.config).toEqual({
          refreshMinutes: 15,
          notifications: false,
        });
        await expect.poll(() => workspace.inputValue()).toBe("Planning");
        await gateway.waitForRequest("plugins.inspect", { after: resetInspections });
        const search = page
          .locator(".plugin-editor")
          .getByRole("searchbox", { name: "Search settings", exact: true });
        await search.fill("Allow prompt changes");
        await page.getByRole("heading", { name: "Permissions", exact: true }).waitFor();
        expect(await page.locator(".plugin-editor__empty").count()).toBe(0);
        const permissionRow = page.locator('[data-setting="hooks.allowPromptInjection"]');
        const permission = permissionRow.getByRole("checkbox");
        const inspections = (await gateway.getRequests("plugins.inspect")).length;
        await gateway.deferNext("plugins.inspect");
        await permissionRow.locator(".plugin-editor__title").click();
        const permissionSave = await gateway.waitForRequest("config.set", { after: 3 });
        await gateway.waitForRequest("plugins.inspect", { after: inspections });
        // A saved edit refreshes inspection without retiring the active editor.
        if (captureUiProof) {
          await page.screenshot({ path: path.join(proofDir, "permission-inspection-refresh.png") });
        }
        expect(await permission.isVisible()).toBe(true);
        expect(await permission.isChecked()).toBe(true);
        expect(await search.inputValue()).toBe("Allow prompt changes");
        await gateway.resolveDeferred("plugins.inspect");
        await expect.poll(() => permission.isVisible()).toBe(true);
        expect(await permission.isChecked()).toBe(true);
        expect(JSON.parse(String(asRecord(permissionSave.params).raw))).toEqual({
          ...config,
          plugins: {
            ...config.plugins,
            entries: {
              workboard: {
                enabled: true,
                hooks: { allowPromptInjection: true },
                config: { refreshMinutes: 15, notifications: false },
              },
            },
          },
        });
        await expect.poll(async () => (await gateway.getRequests("config.set")).length).toBe(4);
        expect(await page.locator("openclaw-settings-save-indicator").count()).toBe(1);
        await search.fill("");

        const uninstallCount = (await gateway.getRequests("plugins.uninstall")).length;
        await gateway.deferNext("plugins.uninstall");
        await page.getByRole("link", { name: "Workboard", exact: true }).click();
        await page.getByRole("button", { name: /(?:Remove|Uninstall) Workboard/iu }).click();
        await page.getByRole("dialog").waitFor();
        await page
          .locator(".exec-approval-actions")
          .getByRole("button", { name: "Remove", exact: true })
          .click();
        await gateway.waitForRequest("plugins.uninstall", { after: uninstallCount });
        await gateway.setMethodResponse("plugins.list", {
          ...inventory,
          plugins: inventory.plugins.filter((plugin) => plugin.id !== workboard.id),
        });
        await gateway.resolveDeferred("plugins.uninstall");
        await page.locator('[data-plugin-id="calendar"]').waitFor();
        expect(await page.locator('[data-plugin-id="workboard"]').count()).toBe(0);
        expect(await page.locator(".plugins-row-message").count()).toBe(0);
        expect(await gateway.getRequests("connect")).toHaveLength(connections);
        expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
      },
    );
  });

  it.each(["click", "Enter"] as const)(
    "retains Settings opened with %j while refreshed inspection finishes",
    async (activation) => {
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
          const inspections = (await gateway.getRequests("plugins.inspect")).length;
          await gateway.deferNext("plugins.inspect");
          await page.getByRole("button", { name: "Disable Workboard", exact: true }).click();
          await gateway.waitForRequest("plugins.inspect", { after: inspections });

          const configuration = page
            .locator(".plugin-catalog-detail__actions")
            .getByRole("link", { name: "Settings", exact: true });
          await configuration.waitFor();
          if (activation === "click") {
            await configuration.click();
          } else {
            await configuration.press(activation);
          }
          await gateway.resolveDeferred("plugins.inspect", inspection);
          await page
            .locator(".plugin-editor")
            .getByRole("searchbox", { name: "Search settings", exact: true })
            .waitFor();
          if (captureUiProof && activation === "click") {
            await page.screenshot({
              animations: "disabled",
              path: path.join(proofDir, "selected-tab-after-inspection.png"),
            });
          }

          await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("settings");
          expect(await page.getByRole("tab").count()).toBe(0);
          await page.getByLabel("Workspace label", { exact: true }).waitFor();
        },
      );
    },
  );

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
        const toggle = page.getByRole("button", { name: "Disable Workboard", exact: true });
        await page
          .locator(".plugin-catalog-detail__actions")
          .getByRole("link", { name: "Settings", exact: true })
          .click();
        const workspace = page.getByLabel("Workspace label", { exact: true });
        expect(await workspace.isDisabled()).toBe(true);
        await page.getByRole("link", { name: "Workboard", exact: true }).click();
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
        await page.getByRole("heading", { level: 1, name: "Workboard", exact: true }).waitFor();
        await page
          .locator(".plugin-catalog-detail__actions")
          .getByRole("link", { name: "Settings", exact: true })
          .click();
        await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("settings");
        expect(
          await page.getByRole("checkbox", { name: "Add context to prompts", exact: true }).count(),
        ).toBe(0);

        await page.getByRole("alert").filter({ hasText: "Configuration unavailable" }).waitFor();
        const configRequests = (await gateway.getRequests("config.get")).length;
        await gateway.setMethodResponse("config.get", configMocks["config.get"]);
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await page.getByLabel("Workspace label", { exact: true }).waitFor();
        await page.getByRole("checkbox", { name: "Add context to prompts", exact: true }).waitFor();
        expect(await gateway.getRequests("config.get")).toHaveLength(configRequests + 1);
      },
    );
  });
});
