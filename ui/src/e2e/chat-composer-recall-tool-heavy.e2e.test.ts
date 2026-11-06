import { expect, it } from "vitest";
import {
  captureUiProof,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("recalls the last user prompt after long assistant activity without losing the draft", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const prompt = "Review all one hundred workspace checks and summarize the result.";
      const draft = "Unsent follow-up draft";
      const messages = [
        { role: "user", content: prompt, timestamp: 1000 },
        ...Array.from({ length: 101 }, (_, index) => ({
          role: "assistant",
          content: `Workspace check ${index + 1} completed.`,
          timestamp: 1001 + index,
        })),
      ];
      await installMockGateway(page, { historyMessages: messages });
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill(draft);
      await composer.press("Home");
      await composer.press("ArrowUp");
      await captureUiProof(suite, page, "recall-tool-heavy", "arrow-up.png");
      expect(await composer.inputValue()).toBe(prompt);
      await composer.press("End");
      await composer.press("ArrowDown");
      await expect.poll(() => composer.inputValue()).toBe(draft);
    });
  });
});
