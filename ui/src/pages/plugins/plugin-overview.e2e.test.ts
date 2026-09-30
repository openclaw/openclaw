import { afterAll, beforeAll, expect, it } from "vitest";
import type { ApplicationContext } from "../../app/context.ts";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
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

describeControlUiE2e("Plugin overview", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it.each(["fresh", "refresh"] as const)(
    "initializes direct catalog Settings on %s entry with editable fields and permissions",
    async (entry) => {
      const context = await newContext();
      const page = await context.newPage();
      const plugin = { ...calendarPlugin, catalogId: "ch_Y2FsZW5kYXI" };
      const config = {
        plugins: {
          entries: {
            [plugin.id]: {
              enabled: true,
              config: { timeZone: "Europe/Paris" },
              hooks: { allowPromptInjection: false },
            },
          },
        },
      };
      const gateway = await installMockGateway(page, {
        featureMethods: [...pluginMethods, "config.get", "config.schema", "config.set"],
        operatorScopes: ["operator.read", "operator.admin"],
        methodResponses: {
          ...pluginMethodResponses(),
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
            schema: {
              type: "object",
              properties: {
                plugins: {
                  type: "object",
                  properties: {
                    entries: {
                      type: "object",
                      properties: {
                        [plugin.id]: {
                          type: "object",
                          properties: {
                            config: {
                              type: "object",
                              properties: { timeZone: { type: "string", title: "Time zone" } },
                            },
                            hooks: {
                              type: "object",
                              additionalProperties: false,
                              properties: {
                                allowPromptInjection: {
                                  type: "boolean",
                                  title: "Allow prompt changes",
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
            uiHints: {},
            version: "calendar-schema",
            generatedAt: "2026-09-15T00:00:00Z",
          },
        },
      });
      try {
        const overviewUrl = `${server.baseUrl}plugins/${plugin.catalogId}`;
        if (entry === "refresh") {
          await page.goto(overviewUrl);
          await page
            .locator(".plugin-catalog-detail__actions")
            .getByRole("link", { name: "Settings", exact: true })
            .click();
          await page.getByRole("textbox", { name: "Time zone", exact: true }).waitFor();
          await page.reload();
        } else {
          await page.goto(`${overviewUrl}?view=settings`);
        }
        await page
          .locator(".plugin-editor")
          .getByRole("searchbox", { name: "Search settings", exact: true })
          .waitFor();
        await page.getByRole("heading", { name: "Permissions", exact: true }).waitFor();
        await captureScreenshot(page, `direct-settings-${entry}.png`, "viewport");
        const timeZone = page.getByRole("textbox", { name: "Time zone", exact: true });
        await timeZone.waitFor();
        expect(await timeZone.inputValue()).toBe("Europe/Paris");
        expect(await timeZone.isEnabled()).toBe(true);
        const permission = page.getByRole("checkbox", {
          name: "Add context to prompts",
          exact: true,
        });
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
        // The request recorder observes dispatch; wait for the owning writer's
        // acknowledgement before reloading the saved permission.
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
        await page.getByRole("textbox", { name: "Time zone", exact: true }).waitFor();
        await expect.poll(() => permission.isChecked()).toBe(true);
        const permissionRow = page.locator('[data-setting="hooks.allowPromptInjection"]');
        await permissionRow.hover();
        await permissionRow
          .getByRole("button", { name: "Actions for Add context to prompts", exact: true })
          .click();
        await permissionRow.locator('wa-dropdown-item[value="reset"]').click();
        await expect.poll(async () => (await gateway.getRequests("config.set")).length).toBe(1);
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
        const writes = await gateway.getRequests("config.set");
        const saved = JSON.parse((writes.at(-1)!.params as { raw: string }).raw);
        expect(saved.plugins.entries[plugin.id].hooks).toEqual({});
        expect(saved.plugins.entries[plugin.id].config).toEqual({ timeZone: "Europe/Paris" });
        await page.reload();
        await permission.waitFor();
        await expect.poll(() => permission.isChecked()).toBe(true);
        expect(
          await permissionRow.locator('wa-dropdown-item[value="reset"]').getAttribute("disabled"),
        ).not.toBeNull();
        await captureScreenshot(page, `direct-settings-${entry}-permissions.png`, "viewport");
        expect(new URL(page.url()).pathname).toBe(`/plugins/${plugin.catalogId}`);
        expect(new URL(page.url()).search).toBe("?view=settings");
      } finally {
        await context.close();
      }
    },
  );

  it("keeps catalog identity while presenting installed controls, complete content, and a contained metadata rail", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const description =
      "Search previous calendar entries. This complete description explains every supported query and return value.\n\n".repeat(
        35,
      ) + "TOOL_DESCRIPTION_TAIL";
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
    await installMockGateway(page, {
      featureMethods: [...pluginMethods, "tools.catalog"],
      methodResponses: {
        ...pluginMethodResponses(),
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
                    {
                      name: "query",
                      required: true,
                      type: "string",
                      description: "Calendar search text.",
                    },
                    {
                      name: "limit",
                      required: false,
                      type: "integer",
                      description: "Maximum number of results.",
                    },
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
    });
    try {
      await page.goto(`${server.baseUrl}plugins/ch_Y2FsZW5kYXI`);
      await page.getByRole("button", { name: "Disable Calendar Plus", exact: true }).waitFor();
      expect(new URL(page.url()).pathname).toBe("/plugins/ch_Y2FsZW5kYXI");
      expect(await page.locator(".plugin-catalog-detail [role=tablist]").count()).toBe(0);
      expect(
        await page.getByRole("link", { name: "@acme", exact: true }).getAttribute("href"),
      ).toBe("https://clawhub.ai/acme");
      expect(await page.locator(".plugin-catalog-detail__security .is-filled").count()).toBe(2);
      expect(await page.locator(".plugin-metadata__repository").textContent()).toContain(
        "Acme/calendar",
      );
      expect(await page.locator(".plugin-catalog-detail__readme").textContent()).toContain(
        "README_TAIL",
      );
      expect(await page.locator(".plugin-capabilities h2").allTextContents()).toEqual([
        "Skills1",
        "Tools2",
        "MCP servers1",
      ]);
      await page.getByRole("button", { name: /calendar_search/ }).click();
      await page.getByRole("dialog", { name: "calendar_search" }).waitFor();
      expect(await page.locator(".plugin-tool-preview p").textContent()).toBe(description);
      const inputs = page.locator(".plugin-tool-preview__parameters");
      expect(await inputs.locator("dt code").allTextContents()).toEqual(["query", "limit"]);
      expect(await inputs.locator("dt span").allTextContents()).toEqual([
        "Required",
        "string",
        "Optional",
        "integer",
      ]);
      expect(await inputs.locator("dd").allTextContents()).toEqual([
        "Calendar search text.",
        "Maximum number of results.",
      ]);
      await captureScreenshot(page, "overview-tool.png", "viewport");
      await page.setViewportSize({ width: 393, height: 852 });
      const modalBounds = await page.locator(".plugin-tool-preview").boundingBox();
      expect(modalBounds!.height).toBeLessThanOrEqual(804);
      await captureScreenshot(page, "overview-tool-mobile.png", "viewport");
      await page.locator(".plugin-tool-preview__body").evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      expect(
        await page.locator(".plugin-tool-preview__body").evaluate((element) => {
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
      await page.getByRole("button", { name: "Close", exact: true }).click();
      for (const width of [1440, 900, 393]) {
        await page.setViewportSize({ width, height: 1000 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(1);
        await captureScreenshot(page, `overview-${width}.png`);
      }
      await page
        .locator(".plugin-catalog-detail__actions")
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      await expect.poll(() => new URL(page.url()).searchParams.get("view")).toBe("settings");
      expect(new URL(page.url()).pathname).toBe("/plugins/ch_Y2FsZW5kYXI");
    } finally {
      await context.close();
    }
  });
});
