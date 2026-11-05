import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { thinkingLevels } from "./chat-flow.test-support.ts";
import { polledFocus } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI composer accessory focus",
});

suite.define(() => {
  it("routes focus by composer accessory purpose", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        models: [{ id: "gpt-5.6", name: "GPT-5.6", provider: "openai" }],
        methodResponses: {
          "sessions.list": {
            count: 1,
            defaults: {
              contextTokens: 200_000,
              model: "gpt-5.6",
              modelProvider: "openai",
              thinkingDefault: "medium",
              thinkingLevels: thinkingLevels("off", "low", "medium", "high"),
            },
            path: "",
            sessions: [
              {
                contextTokens: 200_000,
                key: "main",
                kind: "direct",
                model: "gpt-5.6",
                modelProvider: "openai",
                status: "done",
                totalTokens: 42_000,
                totalTokensFresh: true,
                updatedAt: Date.now(),
              },
            ],
            ts: Date.now(),
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.messages.subscribe");

      const composer = page.locator(".agent-chat__input");
      const textarea = composer.locator("textarea");
      await composer.waitFor({ state: "visible" });
      await page.evaluate(() => {
        const outside = document.createElement("button");
        outside.id = "composer-accessory-focus-sentinel";
        outside.textContent = "Outside focus sentinel";
        document.body.prepend(outside);
      });
      const outside = page.locator("#composer-accessory-focus-sentinel");

      for (const triggerSelector of [
        ".context-usage > details > summary",
        ".chat-controls__effort-picker > summary",
      ]) {
        const trigger = composer.locator(triggerSelector);
        await trigger.waitFor({ state: "visible" });

        for (const origin of [outside, textarea]) {
          await origin.focus();
          await trigger.click();
          expect(await origin.evaluate((element) => document.activeElement === element)).toBe(true);
          await trigger.click();
        }

        await trigger.focus();
        await trigger.press("Enter");
        expect(
          await trigger.evaluate((element) => ({
            focused: document.activeElement === element,
            open: element.closest<HTMLDetailsElement>("details")?.open ?? false,
          })),
        ).toEqual({ focused: true, open: true });
        await trigger.press("Enter");
      }

      const modelTrigger = composer.locator(".chat-controls__model-picker > summary");
      await outside.focus();
      await modelTrigger.click();
      await polledFocus(page.locator(".chat-controls__model-search")).toBe(true);
      await page.keyboard.press("Escape");

      await outside.focus();
      const attachTrigger = composer.locator(".agent-chat__input-btn--attach");
      await attachTrigger.click();
      await polledFocus(attachTrigger).toBe(true);
      expect(
        await page
          .locator(".agent-chat__attach-menu-option")
          .first()
          .evaluate((element) => document.activeElement === element),
      ).toBe(false);
      await page.keyboard.press("Escape");
    });
  });
});
