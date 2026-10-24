import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Models help mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const config = {
  agents: { defaults: { model: "openai/gpt-5.5" } },
  models: { providers: { openai: Object.fromEntries([["apiKey", "[redacted]"]]) } },
};
const helpCopy = [
  ["About the utility model", "short background tasks", "primary model provider"],
  [
    "About thinking defaults",
    "other models map unsupported levels to their closest supported option",
    "Uses the selected model's thinking policy instead of saving a global thinking override.",
  ],
  [
    "About fast mode defaults",
    "Auto starts fast and returns to standard after the model's configured interval",
    "Uses the selected model's fast-mode policy. Unlike Auto, Default does not enable fast mode by itself.",
  ],
] as const;

suite.define(() => {
  it("keeps model help readable in both themes and a narrow layout", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      await suite.withPage(
        {
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
        },
        async ({ page }) => {
          await installMockGateway(page, {
            models: [
              { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
              { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai", available: true },
            ],
            methodResponses: {
              "config.get": {
                config,
                sourceConfig: config,
                hash: colorScheme,
                issues: [],
                raw: JSON.stringify(config),
                valid: true,
              },
              "models.authStatus": { ts: Date.now(), providers: [] },
              "usage.status": { updatedAt: Date.now(), providers: [] },
            },
          });
          await page.goto(suite.server.baseUrl + "settings/model-providers");
          const defaults = page.locator(".model-providers__defaults");
          const utility = defaults
            .locator(".settings-row")
            .filter({ has: page.locator("#model-providers-utility-help") });
          expect(
            await utility
              .locator(".model-providers__label-with-help")
              .evaluate((node) => getComputedStyle(node).columnGap),
          ).toBe("8px");
          let hoverColor: string | undefined;
          for (const [name, explanation, policy] of helpCopy) {
            const button = defaults.getByRole("button", { name, exact: true });
            const tooltip = button.locator("..");
            const popup = tooltip.locator(".tooltip-surface[popover]");
            const color = () => button.evaluate((node) => getComputedStyle(node).color);
            const idleColor = await color();
            await button.hover();
            await expect
              .poll(() => popup.evaluate((node) => node.matches(":popover-open")))
              .toBe(true);
            await expect.poll(() => tooltip.textContent()).toContain(explanation);
            if (name === "About the utility model") {
              await expect.poll(color).not.toBe(idleColor);
              hoverColor = await color();
              expect(await button.locator("svg").count()).toBe(1);
              expect(await button.evaluate((node) => getComputedStyle(node).borderTopWidth)).toBe(
                "0px",
              );
              const box = await button.boundingBox();
              expect(box?.width).toBeLessThanOrEqual(16);
              expect(box?.height).toBeLessThanOrEqual(16);
            } else {
              expect(await color()).toBe(hoverColor);
              const row = defaults.locator(".settings-row").filter({ has: button });
              await expect
                .poll(() =>
                  row.getByRole("radiogroup").locator('input[type="radio"]:checked').inputValue(),
                )
                .toBe("");
            }
            await button.click();
            await expect.poll(() => tooltip.textContent()).toContain(policy);
            await page.locator(".page-title", { hasText: "Models" }).first().click();
          }
          await page.setViewportSize({ height: 844, width: 390 });
          await utility.scrollIntoViewIfNeeded();
          await defaults.getByRole("button", { name: "About the utility model" }).click();
          await expect
            .poll(() =>
              utility
                .locator(".tooltip-surface[popover]")
                .evaluate((node) => node.matches(":popover-open")),
            )
            .toBe(true);
          await expect
            .poll(() =>
              page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
            )
            .toBe(true);
          const box = await utility.locator(".tooltip-rich-content").boundingBox();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(390);
        },
      );
    }
  });
});
