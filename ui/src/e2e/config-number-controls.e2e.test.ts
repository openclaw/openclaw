import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot, objectSchema } from "./config-composer-fixtures.test-support.ts";
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
function values(request: MockGatewayRequest): Record<string, number> {
  return (
    JSON.parse((request.params as { raw: string }).raw) as {
      laboratory: Record<string, number>;
    }
  ).laboratory;
}

suite.define(() => {
  it("starts empty numeric buttons and native arrows at the same permitted endpoint", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot({ laboratory: {} }, "numeric-endpoints", true),
          "config.schema": {
            schema: objectSchema("", {
              laboratory: objectSchema(
                "",
                Object.fromEntries(
                  cases.map(({ key, direction: _direction, ...schema }) => [
                    key,
                    { type: "integer", ...schema },
                  ]),
                ),
              ),
            }),
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
        buttonValues[field.key] = values(request)[field.key]!;
        await expect.poll(() => input.inputValue()).toBe(String(buttonValues[field.key]));
      }
      for (const field of cases) {
        const input = page.getByRole("spinbutton", { name: field.title, exact: true });
        const before = (await gateway.getRequests("config.set")).length;
        await input.fill("");
        await input.blur();
        const cleared = await gateway.waitForRequest("config.set", { after: before });
        expect(values(cleared)).not.toHaveProperty(field.key);
        await expect.poll(() => input.isEnabled()).toBe(true);
        await input.press(field.direction === 1 ? "ArrowUp" : "ArrowDown");
        const request = await gateway.waitForRequest("config.set", { after: before + 1 });
        keyboardValues[field.key] = values(request)[field.key]!;
      }
      const expected = { positive: 1, positiveEven: 2, negative: -1, negativeEven: -2 };
      expect(keyboardValues).toEqual(expected);
      expect(buttonValues).toEqual(expected);
    });
  });
});
