import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

declare global {
  interface Window {
    composerTranscriptLayoutReads: number;
  }
}

const suite = createChatFlowE2eSuite();
suite.define(() => {
  it("does not move ordinary native typing measurements into a later transcript frame", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: Array.from({ length: 50 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          content: `Typing performance history ${index}\n${"Transcript line\n".repeat(4)}`,
          timestamp: 1000 + index,
        })),
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Typing performance history 49", { exact: false }).waitFor();
      const textarea = page.locator(".agent-chat__composer-combobox textarea");
      await textarea.fill("Typing ");
      await waitForChatScrollIdle(page);
      await textarea.focus();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await page.locator(".chat-thread").evaluate((element) => {
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
        if (!descriptor?.get) {
          throw new Error("Missing native transcript geometry getter");
        }
        const read = descriptor.get.bind(element);
        window.composerTranscriptLayoutReads = 0;
        Object.defineProperty(element, "scrollHeight", {
          configurable: true,
          get() {
            window.composerTranscriptLayoutReads += 1;
            return read();
          },
        });
      });
      for (const key of "abcdefghij") {
        await textarea.press(key);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
      }
      expect(await textarea.inputValue()).toBe("Typing abcdefghij");
      expect(await page.evaluate(() => window.composerTranscriptLayoutReads)).toBe(0);
    });
  });
});
