import { afterAll, beforeAll, expect, it } from "vitest";
import type { PluginsSkillsReadResult } from "../../../../packages/gateway-protocol/src/index.ts";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import { reconnectMockGateway } from "../../test-helpers/control-ui-e2e.ts";
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

const skill = {
  name: "Calendar guide",
  description: "Configure your calendar and review all supporting files.",
};
const catalogId = "ch_Y2FsZW5kYXI";
const bundle: PluginsSkillsReadResult = {
  name: skill.name,
  rootPath: "skills/calendar",
  entryPath: "SKILL.md",
  inventoryComplete: true,
  directories: ["references", "scripts", "empty"],
  files: [
    {
      path: "SKILL.md",
      sizeBytes: 90,
      status: "ready",
      content: "# Calendar guide\n\nStart here. [Configuration](references/config.md)",
    },
    {
      path: "references/config.md",
      sizeBytes: 32000,
      status: "ready",
      content:
        "# Configuration\n\n" +
        "Complete author configuration guidance.\n\n".repeat(800) +
        "CONFIGURATION_TAIL",
    },
    { path: "scripts/check.sh", sizeBytes: 20, status: "ready", content: "echo calendar-check" },
  ],
};
function catalog(installed: boolean): PluginDiscoveryDetailResult {
  return {
    plugin: {
      id: catalogId,
      catalog: {
        name: calendarPlugin.name,
        official: false,
        latestVersion: "2.1.0",
        categories: [],
      },
      local: {
        present: installed,
        installed,
        enabled: installed,
        state: installed ? "enabled" : "not-installed",
        ...(installed ? { pluginId: calendarPlugin.id } : {}),
        action: installed ? "manage" : "install",
      },
    },
    detail: {
      origin: "clawhub",
      packageName: "@acme/calendar",
      author: { handle: "acme" },
      topics: [],
      configuration: [],
      mcpServers: [],
      skills: [skill],
      versions: [],
    },
  };
}
const cases = [
  {
    name: "installed settings",
    route: "settings/plugins/calendar-plus",
    installed: true,
    source: "installed",
  },
  {
    name: "installed catalog",
    route: `plugins/${catalogId}`,
    installed: true,
    source: "installed",
  },
  {
    name: "uninstalled catalog",
    route: `plugins/${catalogId}`,
    installed: false,
    source: "catalog",
  },
] as const;
function responses(installed = true) {
  const detail = catalog(installed);
  return {
    ...pluginMethodResponses(),
    "plugins.list": inventory(installed ? [calendarPlugin] : []),
    "plugins.catalog.get": detail,
    "plugins.inspect": {
      ...calendarInspection,
      plugin: calendarPlugin,
      catalog: detail,
      components: { ...calendarInspection.components, skills: [skill.name], skillDetails: [skill] },
    },
    "plugins.skills.read": bundle,
  };
}

describeControlUiE2e("Plugin skill bundle routes", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it.each(cases)(
    "opens the full bundle from $name without installing it",
    async ({ name, route, installed, source }) => {
      const context = await newContext();
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: [...pluginMethods, "plugins.skills.read"],
        methodResponses: responses(installed),
      });
      try {
        await page.goto(`${server.baseUrl}${route}`);
        await page.getByRole("button", { name: new RegExp(skill.name) }).click();
        const request = await gateway.waitForRequest("plugins.skills.read");
        expect(request.params).toEqual(
          source === "installed"
            ? { source, pluginId: calendarPlugin.id, skillName: skill.name }
            : { source, catalogId, version: "2.1.0", skillName: skill.name },
        );
        const modal = page.locator("openclaw-file-preview-modal");
        await modal.getByRole("heading", { name: "SKILL.md", exact: true }).waitFor();
        expect(await modal.getByRole("textbox").count()).toBe(0);
        expect(await modal.getByRole("button", { name: /Copy/ }).count()).toBe(0);
        expect(
          (await modal.locator("summary").allTextContents()).map((text) => text.trim()),
        ).toContain("empty");
        await modal.getByRole("link", { name: "Configuration", exact: true }).click();
        await modal.getByRole("heading", { name: "references/config.md", exact: true }).waitFor();
        expect(await modal.locator(".markdown").textContent()).toContain("CONFIGURATION_TAIL");
        await modal.locator('[data-path="scripts/check.sh"]').click();
        expect(await modal.locator(".code-content").textContent()).toContain("echo calendar-check");
        if (name === "installed settings") {
          for (const width of [1440, 1174, 768, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
            ).toBeLessThanOrEqual(1);
            await captureScreenshot(page, `skill-bundle-${width}.png`, "viewport");
          }
        }
        await page.keyboard.press("Escape");
        await expect.poll(() => modal.count()).toBe(0);
        expect(new URL(page.url()).pathname).toBe(`/${route}`);
        expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
      } finally {
        await context.close();
      }
    },
  );

  it("shows read failure, retries the same source, and discards a pending read on navigation", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...pluginMethods, "plugins.skills.read"],
      methodResponses: responses(),
      deferredMethods: ["plugins.skills.read"],
    });
    try {
      await page.goto(`${server.baseUrl}settings/plugins/calendar-plus`);
      await page.getByRole("button", { name: new RegExp(skill.name) }).click();
      await gateway.waitForRequest("plugins.skills.read");
      await gateway.rejectDeferred("plugins.skills.read", {
        message: "The skill could not be read.",
      });
      const modal = page.locator("openclaw-file-preview-modal");
      await modal.getByRole("alert").waitFor();
      await modal.getByRole("button", { name: "Retry", exact: true }).click();
      await gateway.waitForRequest("plugins.skills.read", { after: 1 });
      await modal.getByRole("heading", { name: "SKILL.md", exact: true }).waitFor();
      expect(
        (await gateway.getRequests("plugins.skills.read")).map((request) => request.params),
      ).toEqual(
        Array.from({ length: 2 }, () => ({
          source: "installed",
          pluginId: calendarPlugin.id,
          skillName: skill.name,
        })),
      );
      await modal.getByRole("button", { name: /^Close/ }).click();
      await gateway.deferNext("plugins.skills.read");
      await page.getByRole("button", { name: new RegExp(skill.name) }).click();
      await gateway.waitForRequest("plugins.skills.read", { after: 2 });
      // Navigate through the existing route owner while the read is still pending.
      await page.evaluate(() => {
        history.pushState({}, "", "/settings/plugins");
        dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect.poll(() => modal.count()).toBe(0);
      await gateway.resolveDeferred("plugins.skills.read", bundle);
      await page
        .getByRole("link", { name: /Calendar Plus/ })
        .first()
        .waitFor();
      expect(await modal.count()).toBe(0);
    } finally {
      await context.close();
    }
  });

  it("retires the open viewer when the Gateway reconnects", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: [...pluginMethods, "plugins.skills.read"],
      methodResponses: responses(),
    });
    try {
      await page.goto(`${server.baseUrl}settings/plugins/calendar-plus`);
      await page.getByRole("button", { name: new RegExp(skill.name) }).click();
      const modal = page.locator("openclaw-file-preview-modal");
      await modal.getByRole("heading", { name: "SKILL.md", exact: true }).waitFor();
      await reconnectMockGateway(page, gateway, "after-skill-preview");
      expect(await modal.count()).toBe(0);
      await page.getByRole("button", { name: new RegExp(skill.name) }).click();
      await gateway.waitForRequest("plugins.skills.read", { after: 1 });
      await modal.getByRole("heading", { name: "SKILL.md", exact: true }).waitFor();
    } finally {
      await context.close();
    }
  });
});
