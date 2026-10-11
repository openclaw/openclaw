import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import type { JsonSchema } from "../components/config-form.shared.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { config, configMocks, pluginResponses } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin whole-value schema controls" });
const correlated = {
  type: "object",
  title: "Mode",
  additionalProperties: false,
  properties: { a: { type: "number" }, b: { type: "number" } },
  enum: [
    { a: 1, b: 1 },
    { a: 2, b: 2 },
  ],
} satisfies JsonSchema;

suite.define(() => {
  it.each<{
    name: string;
    schema: JsonSchema;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    json: boolean;
  }>([
    {
      name: "root union",
      schema: {
        anyOf: [
          {
            type: "object",
            properties: { local: { type: "string" } },
            required: ["local"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { remote: { type: "string" } },
            required: ["remote"],
            additionalProperties: false,
          },
        ],
      },
      before: { local: "Before" },
      after: { remote: "After" },
      json: true,
    },
    {
      name: "root object enum",
      schema: correlated,
      before: { a: 1, b: 1 },
      after: { a: 2, b: 2 },
      json: false,
    },
    {
      name: "nested object enum",
      schema: { type: "object", properties: { mode: correlated } },
      before: { mode: { a: 1, b: 1 } },
      after: { mode: { a: 2, b: 2 } },
      json: false,
    },
  ])(
    "edits and reloads a $name without splitting its value",
    async ({ name, schema, before, after, json }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const saved = {
          ...config,
          plugins: {
            ...config.plugins,
            entries: { workboard: { ...config.plugins.entries.workboard, config: before } },
          },
        };
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read", "operator.admin"],
          methodResponses: {
            ...pluginResponses(),
            "config.get": {
              ...configMocks["config.get"],
              config: saved,
              raw: JSON.stringify(saved),
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
                          workboard: { type: "object", properties: { config: schema } },
                        },
                      },
                    },
                  },
                },
              },
              uiHints: {},
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/plugins/workboard?view=settings`);
        await page
          .locator(".plugin-editor")
          .getByRole("searchbox", { name: "Search settings", exact: true })
          .waitFor();
        const editor = page.locator(".plugin-editor__control");
        await editor.first().waitFor();
        if (process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, `${name.replaceAll(" ", "-")}-initial.png`),
            animations: "disabled",
            caret: "hide",
          });
        }
        if (json) {
          const input = editor.locator("textarea");
          await input.waitFor();
          await input.fill(JSON.stringify(after));
          await input.press("Tab");
        } else {
          await editor
            .getByRole("radio", { name: JSON.stringify({ a: 2, b: 2 }), exact: true })
            .click();
        }
        const write = await gateway.waitForRequest("config.set");
        expect(JSON.parse(String(asRecord(write.params).raw))).toEqual({
          ...saved,
          plugins: {
            ...saved.plugins,
            entries: { workboard: { ...saved.plugins.entries.workboard, config: after } },
          },
        });
        // A captured request precedes the Gateway reply; reload only after
        // the existing writer has acknowledged and retained the saved value.
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
        await page
          .locator(".plugin-editor")
          .getByRole("searchbox", { name: "Search settings", exact: true })
          .waitFor();
        if (json) {
          await expect
            .poll(async () => JSON.parse(await editor.locator("textarea").inputValue()))
            .toEqual(after);
        } else {
          await expect
            .poll(() =>
              editor
                .getByRole("radio", { name: JSON.stringify({ a: 2, b: 2 }), exact: true })
                .isChecked(),
            )
            .toBe(true);
        }
        if (process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, `${name.replaceAll(" ", "-")}-saved.png`),
            animations: "disabled",
            caret: "hide",
          });
        }
      });
    },
  );
});
