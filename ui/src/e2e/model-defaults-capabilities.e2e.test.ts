import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { configAuth } from "./model-catalog-fixtures.test-support.ts";
import { configSnapshot } from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI model default capabilities" });
suite.define(() => {
  it.each([1440, 390])("aligns default capability controls at %ipx", async (width) => {
    await suite.withPage(
      { viewport: { width, height: 1100 }, locale: "en-US" },
      async ({ page }) => {
        const config = {
          agents: {
            defaults: {
              model: "openai/gpt-4.1",
              thinkingDefault: "max",
              fastModeDefault: "ultrafast",
            },
          },
        };
        const models = [
          {
            provider: "openai",
            id: "gpt-4.1",
            name: "QA model with a deliberately long descriptive label",
            available: true,
            reasoning: true,
            thinkingLevels: ["Low", "Max", "Ultra"].map((label) => ({
              id: label.toLowerCase(),
              label,
            })),
            supportsFastMode: true,
            serviceTiers: ["priority", "ultrafast"],
          },
        ];
        const gateway = await installMockGateway(page, {
          assistantName: "QA Assistant",
          models,
          methodResponses: {
            "config.get": configSnapshot(config, "qa-defaults"),
            "models.authStatus": {
              ts: 1,
              providers: [configAuth("openai")],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        await waitForControlUiRoute(page, { routeId: "model-providers" });
        const defaults = page.locator(".model-providers__defaults");
        const pickers = defaults.locator(".model-picker .picker-select__trigger");
        await expect.poll(() => pickers.first().textContent()).toContain(models[0]!.name);
        expect(await pickers.first().textContent()).not.toContain("API");
        expect(await pickers.first().getAttribute("aria-label")).not.toContain("API");
        expect(await pickers.first().locator(".picker-select__description").count()).toBe(0);
        await defaults.scrollIntoViewIfNeeded();
        const boxes = await pickers.evaluateAll((elements) =>
          elements.map((element) => {
            const box = element.getBoundingClientRect();
            return { left: box.left, width: box.width, height: box.height };
          }),
        );
        expect(boxes).toHaveLength(5);
        for (const box of boxes) {
          expect(Math.abs(box.left - boxes[0]!.left)).toBeLessThan(1);
          expect(Math.abs(box.width - boxes[0]!.width)).toBeLessThan(1);
          expect(Math.abs(box.height - boxes[0]!.height)).toBeLessThan(1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await pickers.first().click();
        const option = defaults.locator('[role="option"][data-value="openai/gpt-4.1"]');
        await expect.poll(() => option.isVisible()).toBe(true);
        expect(await option.locator(".picker-select__description").textContent()).toBe("API");
        const metadata = await option.evaluate((element) => {
          const label = element.querySelector<HTMLElement>(".picker-select__label")!;
          const detail = element.querySelector<HTMLElement>(".picker-select__description")!;
          const copy = element.querySelector<HTMLElement>(".picker-select__copy")!;
          const trigger = element
            .closest("openclaw-select-picker")!
            .querySelector(".picker-select__chevron")!;
          const labelBox = label.getBoundingClientRect();
          const detailBox = detail.getBoundingClientRect();
          const menuBox = element.closest(".picker-select__menu")!.getBoundingClientRect();
          return {
            centerOffset: Math.abs(
              (labelBox.top + labelBox.bottom - detailBox.top - detailBox.bottom) / 2,
            ),
            gap: detailBox.left - labelBox.right,
            rightOffset: copy.getBoundingClientRect().right - detailBox.right,
            detailColor: getComputedStyle(detail).color,
            mutedColor: getComputedStyle(trigger).color,
            menuFits: menuBox.left >= 0 && menuBox.right <= innerWidth,
          };
        });
        expect(metadata.centerOffset).toBeLessThan(1);
        expect(metadata.gap).toBeGreaterThan(0);
        expect(Math.abs(metadata.rightOffset)).toBeLessThan(1);
        expect(metadata.detailColor).toBe(metadata.mutedColor);
        expect(metadata.menuFits).toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(() => pickers.first().getAttribute("aria-expanded")).toBe("false");
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      },
    );
  });
});
