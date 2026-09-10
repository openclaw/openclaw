import { writeFile } from "node:fs/promises";
import path from "node:path";
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
      catalog: { name, official: true, categories: [] },
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
          "config.set": { ok: true, hash: "After" },
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
      await page.goto(`${suite.server.baseUrl}settings/plugins/workboard#configuration`);
      await gateway.waitForRequest("plugins.catalog.get");
      await gateway.setMethodResponse("config.get", configResponse("After"));
      await page.getByRole("textbox", { name: "Greeting", exact: true }).fill("After");
      await gateway.waitForRequest("config.set");
      await gateway.waitForRequest("plugins.inspect", { after: 1 });
      await gateway.waitForRequest("plugins.catalog.get", { after: 1 });
      await page
        .locator(".plugin-catalog-detail__tabs")
        .getByRole("tab", { name: "Skills", exact: true })
        .click();
      const rows = page.locator(".plugin-catalog-detail__row h3");
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

  it.each([false, true])(
    "keeps the selected install wizard after an older detail response (installing=%s)",
    async (installing) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const alpha = detail("ch_YWxwaGE", "Alpha");
        const beta = detail("ch_YmV0YQ", "Beta");
        const gateway = await installMockGateway(page, {
          featureMethods,
          deferredMethods: ["plugins.catalog.get"],
          methodResponses: {
            "plugins.list": { plugins: [], diagnostics: [], mutationAllowed: true },
            "plugins.catalog.browse": {
              cases: [
                { match: { intent: "all" }, response: { items: [alpha.plugin, beta.plugin] } },
                { match: { intent: "featured" }, response: { items: [] } },
                { match: { intent: "trending" }, response: { items: [] } },
              ],
            },
            "plugins.catalog.categories": { categories: [] },
            "plugins.catalog.get": beta,
          },
        });
        await page.goto(`${suite.server.baseUrl}plugins`);
        await page.getByRole("button", { name: "Install Alpha", exact: true }).click();
        await gateway.waitForRequest("plugins.catalog.get", { match: { id: alpha.plugin.id } });
        await page.getByRole("button", { name: "Install Beta", exact: true }).click();
        const wizard = page.locator(".plugin-install-wizard");
        await wizard.getByRole("heading", { name: "Beta", exact: true }).waitFor();
        try {
          if (installing) {
            await gateway.deferNext("plugins.install");
            await wizard.getByRole("button", { name: "Install Beta", exact: true }).click();
            const request = await gateway.waitForRequest("plugins.install");
            expect(request.params).toEqual({ source: "clawhub", packageName: "beta" });
          }
          await gateway.resolveDeferred("plugins.catalog.get", alpha);
          await captureSettled(
            page,
            installing ? "plugin-installing-ownership" : "plugin-review-ownership",
            page.locator("openclaw-modal-dialog dialog"),
          );
          expect(await wizard.getByRole("heading").textContent()).toBe("Beta");
          expect(await wizard.getAttribute("data-stage")).toBe(
            installing ? "installing" : "review",
          );
          expect(await gateway.getRequests("plugins.install")).toHaveLength(installing ? 1 : 0);
        } finally {
          if (installing) {
            await gateway.rejectDeferred("plugins.install", {
              code: "UNAVAILABLE",
              message: "Synthetic install complete",
            });
          }
        }
      });
    },
  );
});
