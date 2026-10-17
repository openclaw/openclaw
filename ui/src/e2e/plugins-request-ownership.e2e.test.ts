import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type * as Plugins from "../lib/plugins/index.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  configMocks,
  inspection as baseInspection,
  named,
  objectSchema,
  pluginConfigSchema,
} from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin request ownership" });
const featureMethods = [
  "config.get",
  "config.schema",
  "config.set",
  "plugins.list",
  "plugins.inspect",
  "plugins.catalog.browse",
  "plugins.catalog.categories",
  "plugins.catalog.get",
  "plugins.install",
];
const workboard: Plugins.PluginCatalogItem = {
  id: "workboard",
  name: "Workboard",
  origin: "global",
  installed: true,
  enabled: true,
  state: "enabled",
  version: "1.2.3",
  catalogId: "ch_d29ya2JvYXJk",
};

function detail(id: string, name: string, installed = false): Plugins.PluginDiscoveryDetailResult {
  return {
    plugin: {
      id,
      catalog: { name, official: true, categories: ["productivity"] },
      local: {
        present: installed,
        installed,
        enabled: installed,
        state: installed ? "enabled" : "not-installed",
        action: installed ? "manage" : "install",
      },
    },
    detail: {
      origin: "clawhub",
      packageName: name.toLowerCase(),
      topics: [],
      configuration: [],
      mcpServers: [],
      skills: [],
      versions: [],
    },
  };
}

function inspection(skill: string): Plugins.PluginsInspectResult {
  const { id, name, origin, installed, enabled } = workboard;
  return {
    ok: true,
    reviewToken: "synthetic-review",
    plugin: { id, name, origin, installed, enabled },
    source: { kind: "npm", packageName: "workboard" },
    declared: { ...baseInspection.declared, tools: [] },
    components: {
      ...baseInspection.components,
      mapped: ["skills"],
      skills: [skill],
      mcpServers: [],
    },
    grants: {
      hooks: {
        allowPromptInjection: { effective: false },
        allowConversationAccess: { effective: false },
      },
    },
  };
}

function configResponse(greeting: string) {
  const config = { plugins: { entries: { workboard: { config: { greeting } } } } };
  return {
    ...configMocks["config.get"],
    config,
    hash: greeting,
    appliedConfigHash: greeting,
    raw: JSON.stringify(config),
  };
}

async function settleRender(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

suite.define(() => {
  it("keeps the current rendered inspection after an old optional catalog response", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods,
        deferredMethods: ["plugins.catalog.get"],
        methodResponses: {
          "plugins.list": { plugins: [workboard], diagnostics: [], mutationAllowed: true },
          "plugins.inspect": {
            sequence: [inspection("Original skill"), inspection("Current skill")],
          },
          "plugins.catalog.get": {
            __mockError: { code: "UNAVAILABLE", message: "Optional catalog unavailable" },
          },
          "config.get": configResponse("Before"),
          "config.schema": {
            schema: pluginConfigSchema(
              "workboard",
              objectSchema({ greeting: { type: "string", title: "Greeting" } }),
            ),
            uiHints: {},
            version: "synthetic",
            generatedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/plugins/workboard?view=settings`);
      await gateway.waitForRequest("plugins.catalog.get");
      const greeting = named(page, "textbox", "Greeting");
      await greeting.fill("After");
      await greeting.press("Tab");
      const write = await gateway.waitForRequest("config.set");
      expect(write.params).toMatchObject({ baseHash: "Before", raw: expect.any(String) });
      const raw = asNullableRecord(write.params)?.raw;
      expect.assert(typeof raw === "string");
      expect(JSON.parse(raw)).toHaveProperty("plugins.entries.workboard.config.greeting", "After");
      await gateway.waitForRequest("plugins.inspect", { after: 1 });
      await gateway.waitForRequest("plugins.catalog.get", { after: 1 });
      await named(page.locator(".plugins-settings-breadcrumb"), "link", "Workboard").click();
      const rows = page.locator(".plugin-capability__copy > strong");
      await expect.poll(() => rows.allTextContents()).toEqual(["Current skill"]);

      await gateway.resolveDeferred(
        "plugins.catalog.get",
        detail(workboard.catalogId!, "Workboard", true),
      );
      await settleRender(page);
      expect(await rows.allTextContents()).toEqual(["Current skill"]);
      expect(await gateway.getRequests("plugins.inspect")).toHaveLength(2);
    });
  });

  it("starts only the latest install after an older catalog detail response", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const alpha = detail("ch_YWxwaGE", "Alpha");
      const beta = detail("ch_YmV0YQ", "Beta");
      const gateway = await installMockGateway(page, {
        featureMethods,
        deferredMethods: ["plugins.catalog.get", "plugins.install"],
        methodResponses: {
          "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
          "plugins.catalog.browse": { items: [alpha.plugin, beta.plugin] },
          "plugins.catalog.categories": { categories: [] },
          "plugins.catalog.get": beta,
        },
      });
      await page.goto(`${suite.server.baseUrl}plugins`);
      await named(page, "button", "Install Alpha").first().click();
      await gateway.waitForRequest("plugins.catalog.get", { match: { id: alpha.plugin.id } });
      await named(page, "button", "Install Beta").first().click();
      const request = await gateway.waitForRequest("plugins.install");
      expect(request.params).toEqual({ source: "clawhub", packageName: "beta" });
      await gateway.resolveDeferred("plugins.catalog.get", alpha);
      await settleRender(page);
      expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
      expect(await gateway.getRequests("plugins.install")).toHaveLength(1);
      await gateway.rejectDeferred("plugins.install", {
        code: "UNAVAILABLE",
        message: "Synthetic install complete",
      });
    });
  });
});
