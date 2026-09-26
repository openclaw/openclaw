import { expect, it } from "vitest";
import { CHAT_TRANSCRIPT_END_THRESHOLD_PX } from "../pages/chat/scroll.ts";
import {
  chatThreadDistanceFromBottom,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const historyMessages = Array.from({ length: 50 }, (_, index) => ({
  role: index % 2 === 0 ? "assistant" : "user",
  content: [{ type: "text", text: `History message ${index}\n${"Transcript detail\n".repeat(4)}` }],
  timestamp: 1_700_000_000_000 + index,
}));

suite.define(() => {
  it.each([
    { width: 1440, activation: "mouse" },
    { width: 1440, activation: "Enter" },
    { width: 1440, activation: "Space" },
    { width: 390, activation: "mouse" },
    { width: 390, activation: "Enter" },
    { width: 390, activation: "Space" },
  ])(
    "continues transcript keyboard navigation after Latest ($width, $activation)",
    async ({ width, activation }) => {
      await suite.withPage(
        {
          ...createControlUiE2eContextOptions(),
          viewport: { width, height: 900 },
          reducedMotion: "no-preference",
        },
        async ({ page }) => {
          await installMockGateway(page, { historyMessages });
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("History message 49").waitFor();
          await waitForChatScrollIdle(page);
          const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
          const latest = page.getByRole("button", { name: "Scroll to latest", exact: true });
          await thread.focus();
          await page.keyboard.press("End");
          await waitForChatScrollIdle(page);
          await page.keyboard.press("ArrowUp");
          await expect
            .poll(() => chatThreadDistanceFromBottom(page))
            .toBeGreaterThan(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
          await waitForChatScrollIdle(page);
          await latest.waitFor();
          const beforeFocus = await thread.evaluate((element) => element.scrollTop);
          const focusObservation = await thread.evaluateHandle((element) => {
            const observation: { top: number | null } = { top: null };
            element.addEventListener(
              "focus",
              () => {
                observation.top = element.scrollTop;
              },
              { once: true },
            );
            return observation;
          });
          if (activation === "mouse") {
            await latest.click();
          } else {
            await latest.focus();
            await page.keyboard.press(activation);
          }
          await waitForChatScrollIdle(page);
          await expect
            .poll(() => chatThreadDistanceFromBottom(page))
            .toBeLessThanOrEqual(CHAT_TRANSCRIPT_END_THRESHOLD_PX);
          expect(await thread.evaluate((element) => document.activeElement === element)).toBe(true);
          expect((await focusObservation.jsonValue()).top).toBe(beforeFocus);
          const atEnd = await thread.evaluate((element) => element.scrollTop);
          await page.keyboard.press("ArrowUp");
          await expect
            .poll(() => thread.evaluate((element) => element.scrollTop))
            .toBeLessThan(atEnd);
          await waitForChatScrollIdle(page);
          await page.keyboard.press("Tab");
          expect(await thread.evaluate((element) => document.activeElement === element)).toBe(
            false,
          );
          expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
        },
      );
    },
  );

  it.each([false, true])(
    "preserves composer focus when Latest does not own focus (hidden pane: %s)",
    async (hidden) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        await installMockGateway(page, {
          historyMessages,
          sessions: [
            { key: "agent:main:main", kind: "direct", label: "First conversation", updatedAt: 2 },
            {
              key: "agent:main:second",
              kind: "direct",
              label: "Second conversation",
              updatedAt: 1,
            },
          ],
          sessionTranscripts: { "agent:main:second": { messages: historyMessages } },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("History message 49").waitFor();
        await waitForChatScrollIdle(page);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await thread.focus();
        await page.keyboard.press("ArrowUp");
        const latest = page.getByRole("button", { name: "Scroll to latest", exact: true });
        await latest.waitFor();
        if (hidden) {
          await page
            .locator('[data-session-key="agent:main:second"] a.sidebar-recent-session__link')
            .click();
          await page.locator("openclaw-chat-pane[inert]").waitFor({ state: "attached" });
        }
        const composer = page.locator(
          ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
        );
        await composer.fill("Keep this draft");
        const target = hidden
          ? page.locator("openclaw-chat-pane[inert] .chat-scroll-to-bottom")
          : latest;
        await target.evaluate((element: HTMLButtonElement) => element.click());
        await waitForChatScrollIdle(page);
        expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
        expect(await composer.inputValue()).toBe("Keep this draft");
        expect(await chatThreadDistanceFromBottom(page)).toBeLessThanOrEqual(
          CHAT_TRANSCRIPT_END_THRESHOLD_PX,
        );
      });
    },
  );
});
