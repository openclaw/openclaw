import { expect, it } from "vitest";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("keeps recalled multiline text while moving the caret between its lines", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const recalled = "Review the first section\nThen review the second section";
      await installMockGateway(page, {
        historyMessages: [{ role: "user", content: recalled, timestamp: 1000 }],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Unsent draft");
      await composer.press("Home");
      await composer.press("ArrowUp");
      await expect.poll(() => composer.inputValue()).toBe(recalled);
      await expect
        .poll(() => composer.evaluate((input: HTMLTextAreaElement) => input.selectionStart))
        .toBe(0);
      await composer.press("ArrowRight");
      await composer.press("ArrowDown");
      await captureUiProof(suite, page, "recall-navigation", "arrow-down.png");
      expect(await composer.inputValue()).toBe(recalled);
      await expect
        .poll(() => composer.evaluate((input: HTMLTextAreaElement) => input.selectionStart))
        .toBeGreaterThan(recalled.indexOf("\n"));
      await composer.press("ArrowUp");
      expect(await composer.inputValue()).toBe(recalled);
      await composer.press("End");
      await composer.press("ArrowDown");
      await composer.press("End");
      await composer.press("ArrowDown");
      await expect.poll(() => composer.inputValue()).toBe("Unsent draft");
    });
  });
});
