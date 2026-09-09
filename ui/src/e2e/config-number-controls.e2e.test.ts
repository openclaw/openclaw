import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Settings numeric endpoints" });
const cases = [
  { key: "positive", title: "Positive integer", minimum: 1, multipleOf: 1, direction: 1 },
  { key: "positiveEven", title: "Positive even", minimum: 2, multipleOf: 2, direction: 1 },
  { key: "negative", title: "Negative integer", maximum: -1, multipleOf: 1, direction: -1 },
  { key: "negativeEven", title: "Negative even", maximum: -2, multipleOf: 2, direction: -1 },
] as const;

suite.define(() => {
  it("starts empty numeric buttons and native arrows at the same permitted endpoint", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const config = { laboratory: {} };
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": {
            config,
            raw: JSON.stringify(config),
            hash: "numeric-endpoints",
            appliedConfigHash: "numeric-endpoints",
            configRevisionHash: "numeric-endpoints",
            valid: true,
            issues: [],
          },
          "config.schema": {
            schema: {
              type: "object",
              properties: {
                laboratory: {
                  type: "object",
                  properties: Object.fromEntries(
                    cases.map(({ key, direction: _direction, ...schema }) => [
                      key,
                      { type: "integer", ...schema },
                    ]),
                  ),
                },
              },
            },
            uiHints: {},
            version: "numeric-endpoints",
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/advanced?section=laboratory`);
      const buttonValues: Record<string, number> = {};
      const keyboardValues: Record<string, number> = {};
      for (const field of cases) {
        const input = page.getByRole("spinbutton", { name: field.title, exact: true });
        await expect.poll(() => input.inputValue()).toBe("");
        const before = (await gateway.getRequests("config.set")).length;
        const step = `${field.direction === 1 ? "+" : "-"}${field.multipleOf}`;
        await page.getByRole("button", { name: `${field.title}: ${step}`, exact: true }).click();
        const request = await gateway.waitForRequest("config.set", { after: before });
        const submitted = JSON.parse((request.params as { raw: string }).raw) as {
          laboratory: Record<string, number>;
        };
        buttonValues[field.key] = submitted.laboratory[field.key]!;
        await expect.poll(() => input.inputValue()).toBe(String(buttonValues[field.key]));
      }
      await page.locator("#config-section-panel").screenshot({
        path: path.join(suite.artifactDir, "numeric-buttons.png"),
      });
      for (const field of cases) {
        const input = page.getByRole("spinbutton", { name: field.title, exact: true });
        const before = (await gateway.getRequests("config.set")).length;
        await input.fill("");
        await input.blur();
        const cleared = await gateway.waitForRequest("config.set", { after: before });
        const submitted = JSON.parse((cleared.params as { raw: string }).raw) as {
          laboratory: Record<string, number>;
        };
        expect(submitted.laboratory).not.toHaveProperty(field.key);
        await expect.poll(() => input.isEnabled()).toBe(true);
        await input.press(field.direction === 1 ? "ArrowUp" : "ArrowDown");
        const request = await gateway.waitForRequest("config.set", { after: before + 1 });
        const stepped = JSON.parse((request.params as { raw: string }).raw) as {
          laboratory: Record<string, number>;
        };
        keyboardValues[field.key] = stepped.laboratory[field.key]!;
      }
      await writeFile(
        path.join(suite.artifactDir, "numeric-step-values.json"),
        JSON.stringify({ buttonValues, keyboardValues }, null, 2),
      );
      expect(keyboardValues).toEqual({
        positive: 1,
        positiveEven: 2,
        negative: -1,
        negativeEven: -2,
      });
      expect(buttonValues).toEqual(keyboardValues);
    });
  });
});
