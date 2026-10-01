import { writeFile } from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type {
  PluginCatalogItem,
  PluginDiscoveryDetailResult,
  PluginsInspectResult,
} from "../lib/plugins/index.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin request ownership" });
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
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
const workboard: PluginCatalogItem = {
  id: "workboard",
  name: "Workboard",
  origin: "global",
  installed: true,
  enabled: true,
  state: "enabled",
  version: "1.2.3",
  catalogId: "ch_d29ya2JvYXJk",
};

function detail(id: string, name: string, installed = false): PluginDiscoveryDetailResult {
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

function inspection(skill: string): PluginsInspectResult {
  return {
    ok: true,
    reviewToken: "synthetic-review",
    plugin: {
      id: "workboard",
      name: "Workboard",
      origin: "global",
      installed: true,
      enabled: true,
    },
    source: { kind: "npm", packageName: "workboard" },
    declared: {
      channels: [],
      providers: [],
      tools: [],
      contracts: [],
      hooks: [],
      mcpServers: [],
      cliCommands: [],
      cliBackends: [],
      skills: [],
      dangerousConfigFlags: [],
    },
    components: {
      mapped: ["skills"],
      skills: [skill],
      mcpServers: [],
      commands: [],
      hooks: [],
      lspServers: [],
      unavailable: { capabilities: [], mcpServers: [], lspServers: [] },
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
    config,
    hash: greeting,
    appliedConfigHash: greeting,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

async function captureSettled(page: Page, name: string, surface: Locator = page.locator(".shell")) {
  // Delivered RPC callbacks and Lit updates settle before sampling the visible surface.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
  if (capture) {
    const dir = createControlUiE2eArtifactDir(name);
    await writeFile(
      path.join(dir, "result.png"),
      await takeControlUiViewportScreenshot(page, surface, [page.locator("openclaw-plugins-page")]),
    );
  }
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
            schema: {
              type: "object",
              properties: {
                plugins: {
                  type: "object",
                  properties: {
                    entries: {
                      type: "object",
                      properties: {
                        workboard: {
                          type: "object",
                          properties: {
                            config: {
                              type: "object",
                              properties: { greeting: { type: "string", title: "Greeting" } },
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
            version: "synthetic",
            generatedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/plugins/workboard?view=settings`);
      await gateway.waitForRequest("plugins.catalog.get");
      const greeting = page.getByRole("textbox", { name: "Greeting", exact: true });
      await greeting.fill("After");
      await greeting.press("Tab");
      const write = await gateway.waitForRequest("config.set");
      expect(write.params).toMatchObject({ baseHash: "Before", raw: expect.any(String) });
      const raw = asNullableRecord(write.params)?.raw;
      expect.assert(typeof raw === "string");
      expect(JSON.parse(raw)).toHaveProperty("plugins.entries.workboard.config.greeting", "After");
      await gateway.waitForRequest("plugins.inspect", { after: 1 });
      await gateway.waitForRequest("plugins.catalog.get", { after: 1 });
      await page
        .locator(".plugins-settings-breadcrumb")
        .getByRole("link", { name: "Workboard", exact: true })
        .click();
      const rows = page.locator(".plugin-capability__copy > strong");
      await expect.poll(() => rows.allTextContents()).toEqual(["Current skill"]);

      await gateway.resolveDeferred(
        "plugins.catalog.get",
        detail(workboard.catalogId!, "Workboard", true),
      );
      await captureSettled(page, "plugin-inspection-ownership");
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
          "plugins.catalog.categories": {
            categories: [
              {
                slug: "productivity",
                label: "Productivity",
                description: "Tasks and work organization.",
                icon: "list-todo",
                order: 0,
              },
            ],
          },
          "plugins.catalog.get": beta,
        },
      });
      await page.goto(`${suite.server.baseUrl}plugins`);
      await page.getByRole("button", { name: "Install Alpha", exact: true }).first().click();
      await gateway.waitForRequest("plugins.catalog.get", { match: { id: alpha.plugin.id } });
      await page.getByRole("button", { name: "Install Beta", exact: true }).first().click();
      const request = await gateway.waitForRequest("plugins.install");
      expect(request.params).toEqual({ source: "clawhub", packageName: "beta" });
      await gateway.resolveDeferred("plugins.catalog.get", alpha);
      await captureSettled(page, "plugin-installing-ownership");
      expect(await page.locator("openclaw-modal-dialog").count()).toBe(0);
      expect(await gateway.getRequests("plugins.install")).toHaveLength(1);
      await gateway.rejectDeferred("plugins.install", {
        code: "UNAVAILABLE",
        message: "Synthetic install complete",
      });
    });
  });
});
