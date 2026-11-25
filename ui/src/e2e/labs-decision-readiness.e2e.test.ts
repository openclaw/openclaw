import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Labs rejected decision preference mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const options = {
  colorScheme: "dark",
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { width: 1280, height: 1000 },
} as const;
suite.define(() => {
  it("keeps the prediction model picker and the next setting still when the choice changes", async () => {
    await suite.withPage(
      { ...options, hasTouch: true, isMobile: true, viewport: { width: 1180, height: 820 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: { "config.get": configSnapshot({}, "labs-picker-1") },
        });
        await page.goto(suite.server.baseUrl + "settings/labs");
        const labs = page.locator("openclaw-labs-page");
        const picker = labs.getByRole("combobox", { name: "Prediction model" });
        const next = labs.getByText("Speech bubbles", { exact: true });
        await labs.getByRole("switch", { name: "Decision assistance" }).waitFor();
        await picker.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        const original = await picker.boundingBox();
        const originalNext = await next.boundingBox();
        await gateway.deferNext("config.patch");
        await picker.tap();
        await picker.getByRole("option", { name: "Session model" }).tap();
        await gateway.waitForRequest("config.patch");
        const updated = configSnapshot(
          {
            gateway: {
              controlUi: { experimental: { composerPredictions: { model: "conversation" } } },
            },
          },
          "labs-picker-2",
        );
        await gateway.setMethodResponse("config.get", updated);
        await gateway.resolveDeferred("config.patch", { ok: true, ...updated });
        await expect.poll(() => picker.isEnabled()).toBe(true);
        expect(await picker.inputValue()).toBe("conversation");
        expect(await picker.boundingBox()).toEqual(original);
        expect(await next.boundingBox()).toEqual(originalNext);
      },
    );
  });

  it("paints the leading focus edge of Labs help when enlarged phone text wraps the link", async () => {
    await suite.withPage(
      { ...options, viewport: { width: 390, height: 844 } },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: { "config.get": configSnapshot({}, "labs-focus") },
        });
        await page.goto(suite.server.baseUrl + "settings/general");
        const typography = page.locator("#settings-appearance-typography");
        await typography.locator(".settings-segmented__btn").filter({ hasText: "140%" }).click();
        await expect
          .poll(() => typography.locator(".settings-segmented__input:checked").inputValue())
          .toBe("140");
        await page.goto(suite.server.baseUrl + "settings/labs");
        const labs = page.locator("openclaw-labs-page");
        const link = labs.getByRole("link", { name: "Learn more" });
        const decision = labs.getByRole("switch", { name: "Decision assistance" });
        await decision.waitFor();
        await page.evaluate(() => document.fonts.ready);
        const strip = await link.evaluate((anchor) => {
          const bounds = anchor.getBoundingClientRect();
          const header = anchor.closest(".content-header")!.getBoundingClientRect();
          return {
            left: bounds.left,
            headerLeft: header.left,
            y: Math.round(bounds.top + bounds.height / 2),
          };
        });
        expect(strip.left).toBe(strip.headerLeft);
        const clip = { x: Math.round(strip.left) - 4, y: strip.y, width: 2, height: 2 };
        const resting = await page.screenshot({ clip, animations: "disabled" });
        await decision.focus();
        await decision.press("Shift+Tab");
        expect(await link.evaluate((anchor) => anchor.matches(":focus-visible"))).toBe(true);
        expect(await page.screenshot({ clip, animations: "disabled" })).not.toEqual(resting);
      },
    );
  });

  it("keeps Labs decision readiness distinct and recovers a rejected save", async () => {
    await suite.withPage(options, async ({ page }) => {
      const saved = configSnapshot(
        { agents: { defaults: { experimental: { decisionAssistance: true } } } },
        "labs-review-1",
      );
      const gateway = await installMockGateway(page, {
        deferredMethods: ["config.get"],
        methodResponses: { "config.get": saved },
      });
      await page.goto(suite.server.baseUrl + "settings/labs");
      await gateway.waitForRequest("config.get");
      expect(
        await page
          .getByText("Couldn’t load this setting. Reconnect or refresh to try again.")
          .count(),
      ).toBe(0);
      await gateway.rejectDeferred("config.get", {
        code: "UNAVAILABLE",
        message: "Configuration temporarily unavailable",
      });
      const row = page.locator("openclaw-labs-page .settings-row", {
        has: page.locator(".settings-row__title", { hasText: "Decision assistance" }),
      });
      await row
        .getByText("Couldn’t load this setting. Reconnect or refresh to try again.")
        .waitFor();
      expect(await row.getByRole("switch").count()).toBe(0);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      await gateway.deferNext("config.get");
      await row.getByRole("button").click();
      await row.getByText("Loading setting", { exact: false }).waitFor();
      expect(await row.getByRole("switch").count()).toBe(0);
      await gateway.resolveDeferred("config.get", saved);
      const toggle = row.getByRole("switch", { name: "Decision assistance", exact: true });
      await expect.poll(() => toggle.isChecked()).toBe(true);
      await gateway.deferNext("config.patch");
      await toggle.uncheck();
      await gateway.waitForRequest("config.patch");
      await gateway.rejectDeferred("config.patch", {
        code: "INVALID_REQUEST",
        message: "Synthetic settings write refused",
        details: {
          issues: [
            {
              path: "agents.defaults.experimental.decisionAssistance",
              message: "Synthetic validation rejection",
            },
          ],
        },
      });
      const alert = page.locator("openclaw-labs-page").getByRole("alert");
      await alert.waitFor();
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const artifacts = createControlUiE2eArtifactDir("labs-save-readiness-review");
        const frame = await takeControlUiScreenshotFrame(page, row, [row], {
          elements: [row],
          animations: "disabled",
          scrollTo: row,
        });
        await writeFile(path.join(artifacts, "rejected-save.png"), frame.png);
      }
      expect(await row.textContent()).not.toContain("Couldn’t load this setting");
      await expect.poll(() => toggle.isChecked()).toBe(true);
      await gateway.deferNext("config.patch");
      await toggle.uncheck();
      await gateway.waitForRequest("config.patch", { after: 1 });
      await expect.poll(() => alert.count()).toBe(0);
      const updated = configSnapshot(
        { agents: { defaults: { experimental: { decisionAssistance: false } } } },
        "labs-review-2",
      );
      await gateway.setMethodResponse("config.get", updated);
      await gateway.resolveDeferred("config.patch", { ok: true, ...updated });
      await expect.poll(() => toggle.isChecked()).toBe(false);
      await expect.poll(() => toggle.getAttribute("aria-disabled")).not.toBe("true");
      expect(await gateway.getRequests("config.patch")).toHaveLength(2);
    });
  });
});
