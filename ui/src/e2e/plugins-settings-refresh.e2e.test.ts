import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { configMocks, inspection, workboard } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin settings background refresh" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it.each(["github", "workboard"])(
    "keeps %s settings interactive through save notifications and catalog refreshes",
    async (pluginId) => {
      await suite.withPage(
        {
          viewport: { width: 1280, height: 900 },
          recordVideo: captureProof
            ? { dir: suite.artifactDir, size: { width: 1280, height: 900 } }
            : undefined,
        },
        async ({ page }) => {
          const plugin = {
            ...workboard,
            id: pluginId,
            name: pluginId === "github" ? "GitHub" : "Workboard",
            origin: "bundled",
          };
          const entry = { enabled: true, hooks: { allowPromptInjection: false } };
          const config = { plugins: { entries: { [pluginId]: entry } } };
          const schema = configMocks["config.schema"].schema;
          const gateway = await installMockGateway(page, {
            operatorScopes: ["operator.read", "operator.admin"],
            methodResponses: {
              "plugins.list": { plugins: [plugin], diagnostics: [], mutationAllowed: true },
              "plugins.inspect": { ...inspection, plugin, catalog: undefined },
              "config.get": {
                ...configMocks["config.get"],
                config,
                raw: JSON.stringify(config),
              },
              "config.schema": {
                ...configMocks["config.schema"],
                uiHints: {},
                schema: {
                  type: "object",
                  properties: {
                    plugins: {
                      type: "object",
                      properties: {
                        entries: {
                          type: "object",
                          properties: {
                            [pluginId]: {
                              ...schema.properties.plugins.properties.entries.properties.workboard,
                              properties: {
                                hooks:
                                  schema.properties.plugins.properties.entries.properties.workboard
                                    .properties.hooks,
                                config: {
                                  type: "object",
                                  additionalProperties: false,
                                  properties: {},
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
          });
          const url = `${suite.server.baseUrl}settings/plugins/${pluginId}?view=settings`;
          await page.goto(url);
          const toggle = page.getByRole("checkbox", {
            name: "Add context to prompts",
            exact: true,
          });
          await toggle.waitFor();
          const editor = await page.locator("openclaw-plugin-settings-editor").elementHandle();
          const connects = (await gateway.getRequests("connect")).length;
          await gateway.deferNext("config.set");
          await toggle.click();
          await gateway.waitForRequest("config.set");
          const lists = (await gateway.getRequests("plugins.list")).length;
          await gateway.deferNext("plugins.list");
          await gateway.resolveDeferred("config.set");
          await gateway.waitForRequest("plugins.list", { after: lists });

          const gets = (await gateway.getRequests("config.get")).length;
          await gateway.deferNext("config.get");
          await gateway.emitGatewayEvent("config.changed", {});
          await gateway.waitForRequest("config.get", { after: gets });
          if (captureProof) {
            await page.screenshot({
              path: path.join(suite.artifactDir, `${pluginId}-refresh.png`),
            });
            console.log(`Plugin settings proof: ${suite.artifactDir}`);
          }
          expect(await toggle.isEnabled()).toBe(true);
          expect(await toggle.evaluate((element) => element.matches(":focus"))).toBe(true);
          expect(await editor?.evaluate((element) => element.isConnected)).toBe(true);

          // A second edit must remain usable while the first save's snapshot is pending.
          await gateway.deferNext("config.set");
          await toggle.click();
          await gateway.resolveDeferred("config.get");
          await gateway.resolveDeferred("plugins.list");
          const second = await gateway.waitForRequest("config.set", { after: 1 });
          expect(JSON.parse((second.params as { raw: string }).raw)).toEqual(config);
          await gateway.resolveDeferred("config.set");
          expect(page.url()).toBe(url);
          expect(await gateway.getRequests("connect")).toHaveLength(connects);
          expect(await editor?.evaluate((element) => element.isConnected)).toBe(true);
        },
      );
    },
  );
});
