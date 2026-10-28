import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import type { JsonSchema } from "../components/config-form.shared.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { objectSchema } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { config, configMocks, pluginResponses } from "./plugins-settings-admin.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Plugin whole-value schema controls" });
const unionMember = (key: string): JsonSchema => ({
  type: "object",
  properties: { [key]: { type: "string" } },
  required: [key],
  additionalProperties: false,
});
const pluginConfig = (value: Record<string, unknown>) => ({
  ...config,
  plugins: {
    ...config.plugins,
    entries: { workboard: { ...config.plugins.entries.workboard, config: value } },
  },
});
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
  it.each([
    {
      name: "root union",
      schema: {
        anyOf: [unionMember("local"), unionMember("remote")],
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
    async ({ schema, before, after, json }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const saved = pluginConfig(before);
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
              schema: objectSchema("", {
                plugins: objectSchema("", {
                  entries: objectSchema("", {
                    workboard: objectSchema("", { config: schema }),
                  }),
                }),
              }),
              uiHints: {},
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/plugins/workboard?view=settings`);
        const search = page.locator(".plugin-editor").getByRole("searchbox", {
          name: "Search settings",
          exact: true,
        });
        await search.waitFor();
        const editor = page.locator(".plugin-editor__control");
        const choice = editor.getByRole("radio", {
          name: JSON.stringify({ a: 2, b: 2 }),
          exact: true,
        });
        await editor.first().waitFor();
        if (json) {
          const input = editor.locator("textarea");
          await input.waitFor();
          await input.fill(JSON.stringify(after));
          await input.press("Tab");
        } else {
          await choice.click();
        }
        const write = await gateway.waitForRequest("config.set");
        expect(JSON.parse(String(asRecord(write.params).raw))).toEqual(pluginConfig(after));
        // A captured request precedes the Gateway reply; reload only after
        // the existing writer has acknowledged and retained the saved value.
        await page.getByRole("button", { name: "Apply changes", exact: true }).waitFor();
        await page.reload();
        await search.waitFor();
        if (json) {
          await expect
            .poll(async () => JSON.parse(await editor.locator("textarea").inputValue()))
            .toEqual(after);
        } else {
          await expect.poll(() => choice.isChecked()).toBe(true);
        }
      });
    },
  );
});
