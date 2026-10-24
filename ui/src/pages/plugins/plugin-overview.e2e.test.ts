import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  calendarInspection,
  calendarPlugin,
  captureScreenshot,
  describeControlUiE2e,
  installMockGateway,
  inventory,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "./plugins.e2e.test-support.ts";

function role(root: Page | Locator, kind: Parameters<Page["getByRole"]>[0], name: string) {
  return root.getByRole(kind, { name, exact: true });
}

const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties });
const plugin = { ...calendarPlugin, catalogId: "ch_Y2FsZW5kYXI" };
const pluginEntries = (entry: unknown) => ({ plugins: { entries: { [plugin.id]: entry } } });
const parameter = (name: string, required: boolean, type: string, description: string) => ({
  name,
  required,
  type,
  description,
});

async function setup(
  methodResponses: Record<string, unknown>,
  featureMethods = pluginMethods,
  operatorScopes?: string[],
) {
  const context = await newContext();
  onTestFinished(() => context.close());
  const page = await context.newPage();
  const gateway = await installMockGateway(page, {
    featureMethods,
    operatorScopes,
    methodResponses: { ...pluginMethodResponses(), ...methodResponses },
  });
  return { page, gateway };
}

describeControlUiE2e("Plugin overview", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it.each(["fresh", "refresh"] as const)(
    "initializes direct catalog Settings on %s entry with editable fields and permissions",
    async (entry) => {
      const config = pluginEntries({
        enabled: true,
        config: { timeZone: "Europe/Paris" },
        hooks: { allowPromptInjection: false },
      });
      const { page, gateway } = await setup(
        {
          "plugins.list": inventory([plugin]),
          "plugins.inspect": { ...calendarInspection, plugin },
          "plugins.catalog.get": {
            __mockError: { code: "UNAVAILABLE", message: "Optional catalog unavailable" },
          },
          "config.get": {
            config,
            raw: JSON.stringify(config),
            hash: "calendar-config",
            appliedConfigHash: "calendar-config",
            valid: true,
            issues: [],
          },
          "config.schema": {
            schema: objectSchema({
              plugins: objectSchema({
                entries: objectSchema({
                  [plugin.id]: objectSchema({
                    config: objectSchema({ timeZone: { type: "string", title: "Time zone" } }),
                    hooks: {
                      ...objectSchema({
                        allowPromptInjection: { type: "boolean", title: "Allow prompt changes" },
                      }),
                      additionalProperties: false,
                    },
                  }),
                }),
              }),
            }),
            uiHints: {},
            version: "calendar-schema",
            generatedAt: "2026-09-15T00:00:00Z",
          },
        },
        [...pluginMethods, "config.get", "config.schema", "config.set"],
        ["operator.read", "operator.admin"],
      );
      const overviewUrl = `${server.baseUrl}plugins/${plugin.catalogId}`;
      if (entry === "refresh") {
        await page.goto(overviewUrl);
        await role(page.locator(".plugin-catalog-detail__actions"), "link", "Settings").click();
        await role(page, "textbox", "Time zone").waitFor();
        await page.reload();
      } else {
        await page.goto(`${overviewUrl}?view=settings`);
      }
      await role(page.locator(".plugin-editor"), "searchbox", "Search settings").waitFor();
      await role(page, "heading", "Permissions").waitFor();
      await captureScreenshot(page, `direct-settings-${entry}.png`, "viewport");
      const timeZone = role(page, "textbox", "Time zone");
      await timeZone.waitFor();
      expect(await timeZone.inputValue()).toBe("Europe/Paris");
      expect(await timeZone.isEnabled()).toBe(true);
      const permission = role(page, "checkbox", "Add context to prompts");
      expect(await permission.isEnabled()).toBe(true);
      expect(await gateway.getRequests("config.set")).toEqual([]);
      const inspections = (await gateway.getRequests("plugins.inspect")).length;
      await gateway.deferNext("plugins.inspect");
      await permission.press("Space");
      await expect.poll(() => permission.isChecked()).toBe(true);
      await expect.poll(async () => (await gateway.getRequests("config.set")).length).toBe(1);
      await gateway.waitForRequest("plugins.inspect", { after: inspections });
      expect(await permission.isVisible()).toBe(true);
      await captureScreenshot(page, `direct-settings-${entry}-refresh.png`, "viewport");
      await gateway.resolveDeferred("plugins.inspect");
      expect(await permission.isChecked()).toBe(true);
      await page.reload();
      await role(page, "textbox", "Time zone").waitFor();
      await expect.poll(() => permission.isChecked()).toBe(true);
      const permissionRow = page.locator('[data-setting="hooks.allowPromptInjection"]');
      await permissionRow.hover();
      await role(permissionRow, "button", "Actions for Add context to prompts").click();
      const resetInspections = (await gateway.getRequests("plugins.inspect")).length;
      await role(permissionRow, "menuitem", "Reset value").click();
      await expect.poll(async () => (await gateway.getRequests("config.set")).length).toBe(1);
      await gateway.waitForRequest("plugins.inspect", { after: resetInspections });
      const writes = await gateway.getRequests("config.set");
      const saved = JSON.parse((writes.at(-1)!.params as { raw: string }).raw);
      const savedEntry = saved.plugins.entries[plugin.id];
      expect([savedEntry.hooks, savedEntry.config]).toEqual([{}, { timeZone: "Europe/Paris" }]);
      await page.reload();
      await permission.waitFor();
      await expect.poll(() => permission.isChecked()).toBe(true);
      expect(
        await permissionRow
          .getByRole("menuitem", { name: "Reset value", exact: true, includeHidden: true })
          .getAttribute("disabled"),
      ).not.toBeNull();
      await captureScreenshot(page, `direct-settings-${entry}-permissions.png`, "viewport");
      expect(new URL(page.url())).toMatchObject({
        pathname: `/plugins/${plugin.catalogId}`,
        search: "?view=settings",
      });
    },
  );

  it("explains a single-server integration instead of repeating setup instructions when enabled", async () => {
    const summary = "Find, create, and update Linear issues, projects, and comments.";
    const setupText = "Enable this plugin and connect your account in OpenClaw.";
    const linear = {
      ...calendarPlugin,
      id: "linear",
      name: "Linear",
      packageName: "@openclaw/linear",
      description: summary,
    };
    const catalog: PluginDiscoveryDetailResult = {
      plugin: {
        id: "ch_bGluZWFy",
        catalog: {
          name: "Linear",
          summary,
          family: "bundle-plugin",
          official: true,
          categories: ["productivity"],
        },
        local: {
          present: true,
          installed: true,
          enabled: true,
          state: "enabled",
          pluginId: "linear",
          action: "manage",
        },
      },
      detail: {
        origin: "clawhub",
        packageName: "@openclaw/linear",
        author: { handle: "openclaw", displayName: "OpenClaw", official: true },
        topics: [],
        configuration: [],
        skills: [],
        versions: [],
        mcpServers: ["linear"],
        mcpServerDetails: [
          {
            name: "linear",
            url: "https://mcp.linear.app/mcp",
            transport: "streamable-http",
            auth: "oauth",
            setup: setupText,
          },
        ],
      },
    };
    const { page } = await setup({
      "plugins.list": inventory([linear]),
      "plugins.catalog.get": catalog,
      "plugins.inspect": {
        ...calendarInspection,
        plugin: { ...calendarInspection.plugin, id: "linear", name: "Linear" },
        catalog,
        declared: { ...calendarInspection.declared, tools: [], mcpServers: ["linear"] },
        components: {
          mapped: [],
          skills: [],
          mcpServers: ["linear"],
          commands: [],
          hooks: [],
          lspServers: [],
          unavailable: { capabilities: [], mcpServers: [], lspServers: [] },
        },
      },
    });
    await page.goto(server.baseUrl + "plugins/ch_bGluZWFy");
    const disable = role(page, "button", "Disable Linear");
    await disable.waitFor();
    await page.locator(".plugin-capability__disclosure summary").click();
    const details = page.locator(".plugin-capability__details");
    await details.getByText("OAuth", { exact: true }).waitFor();
    if (process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1") {
      const artifactDir = createControlUiE2eArtifactDir("linear-mcp");
      const frame = await takeControlUiScreenshotFrame(
        page,
        page.locator(".plugin-catalog-detail"),
        [disable, details],
        { animations: "disabled" },
      );
      writeFileSync(path.join(artifactDir, "linear-mcp.png"), frame.png);
    }
    expect(await details.locator("dt").allTextContents()).toContain("What this server does");
    expect(await details.locator("dd").allTextContents()).toContain(summary);
    expect(await details.textContent()).not.toContain(setupText);
  });

  it("keeps catalog identity while presenting installed controls, complete content, and a contained metadata rail", async () => {
    const description = `${"Search previous calendar entries.\n\n".repeat(120)}TOOL_DESCRIPTION_TAIL`;
    const catalog: PluginDiscoveryDetailResult = {
      plugin: {
        id: "ch_Y2FsZW5kYXI",
        catalog: {
          name: calendarPlugin.name,
          official: false,
          categories: ["tools"],
          downloads: 404,
        },
        local: {
          present: true,
          installed: true,
          enabled: true,
          state: "enabled",
          pluginId: calendarPlugin.id,
          action: "manage",
        },
      },
      detail: {
        origin: "clawhub",
        packageName: "@acme/calendar",
        author: { handle: "acme", displayName: "Acme", official: true },
        topics: [],
        readme: `# Calendar guide\n\n${"A complete guide to calendar search.\n\n".repeat(80)}README_TAIL`,
        repositoryUrl: "git+https://github.com/Acme/calendar.git",
        documentationUrl: "https://example.com/calendar/docs",
        configuration: [],
        mcpServers: [],
        skills: [],
        versions: [],
        security: {
          status: "clean",
          verdict: "review",
          auditUrl: "https://clawhub.ai/acme/plugins/calendar/security-audit?version=1.0",
        },
      },
    };
    const { page } = await setup(
      {
        "plugins.list": inventory([calendarPlugin]),
        "plugins.catalog.get": catalog,
        "plugins.inspect": {
          ...calendarInspection,
          catalog,
          components: {
            ...calendarInspection.components,
            skills: ["Calendar planning"],
            mcpServers: ["calendar-mcp"],
            commands: ["calendar-command"],
            hooks: ["calendar-hook"],
            lspServers: ["calendar-lsp"],
          },
        },
        "tools.catalog": {
          agentId: "main",
          profiles: [],
          groups: [
            {
              id: "plugin:calendar-plus",
              label: "Calendar",
              source: "plugin",
              pluginId: calendarPlugin.id,
              tools: [
                {
                  id: "calendar_search",
                  label: "Calendar search",
                  description: "Search previous entries.",
                  fullDescription: description,
                  parameters: [
                    parameter("query", true, "string", "Calendar search text."),
                    parameter("limit", false, "integer", "Maximum number of results."),
                  ],
                  source: "plugin",
                  pluginId: calendarPlugin.id,
                  defaultProfiles: [],
                },
              ],
            },
          ],
        },
      },
      [...pluginMethods, "tools.catalog"],
    );
    await page.goto(`${server.baseUrl}plugins/ch_Y2FsZW5kYXI`);
    await role(page, "button", "Disable Calendar Plus").waitFor();
    const content = (selector: string) => page.locator(selector).textContent();
    expect(new URL(page.url()).pathname).toBe("/plugins/ch_Y2FsZW5kYXI");
    expect(await page.locator(".plugin-catalog-detail [role=tablist]").count()).toBe(0);
    expect(await role(page, "link", "@acme").getAttribute("href")).toBe("https://clawhub.ai/acme");
    expect(await page.locator(".plugin-catalog-detail__security .is-filled").count()).toBe(2);
    expect(await content(".plugin-metadata__repository")).toContain("Acme/calendar");
    expect(await content(".plugin-catalog-detail__readme")).toContain("README_TAIL");
    expect(await page.locator(".plugin-capabilities h2").allTextContents()).toEqual([
      "Skills1",
      "Tools2",
      "MCP Server1",
    ]);
    await page.getByRole("button", { name: /calendar_search/ }).click();
    await page.getByRole("dialog", { name: "calendar_search" }).waitFor();
    const preview = page.locator(".plugin-tool-preview");
    const inputs = page.locator(".plugin-tool-preview__parameters");
    expect(await preview.locator("p").textContent()).toBe(description);
    for (const [selector, expected] of [
      ["dt code", ["query", "limit"]],
      ["dt span", ["Required", "string", "Optional", "integer"]],
      ["dd", ["Calendar search text.", "Maximum number of results."]],
    ] as const) {
      expect(await inputs.locator(selector).allTextContents()).toEqual(expected);
    }
    await captureScreenshot(page, "overview-tool.png", "viewport");
    await page.setViewportSize({ width: 393, height: 852 });
    const modalBounds = await preview.boundingBox();
    expect(modalBounds!.height).toBeLessThanOrEqual(804);
    await captureScreenshot(page, "overview-tool-mobile.png", "viewport");
    const body = page.locator(".plugin-tool-preview__body");
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(
      await body.evaluate((element) => {
        const paragraph = element.querySelector("p");
        if (!paragraph) {
          return false;
        }
        return (
          element.scrollTop > 0 &&
          paragraph.textContent?.endsWith("TOOL_DESCRIPTION_TAIL") &&
          paragraph.getBoundingClientRect().bottom <= element.getBoundingClientRect().bottom + 1
        );
      }),
    ).toBe(true);
    await captureScreenshot(page, "overview-tool-mobile-tail.png", "viewport");
    await role(page, "button", "Close").click();
    for (const width of [1440, 900, 393]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
      await captureScreenshot(page, `overview-${width}.png`);
    }
    await role(page.locator(".plugin-catalog-detail__actions"), "link", "Settings").click();
    await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("settings");
    expect(new URL(page.url()).pathname).toBe("/plugins/ch_Y2FsZW5kYXI");
  });
});
