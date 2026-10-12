import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "side-chat typography" });
const questionText = "What changed?";
const question = `${questionText}\n\n\`\`\`text\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n\`\`\``;
const answerCode = `const detail = "${"A long line in a narrow side chat. ".repeat(6)}";`;
const answer = `The same readable answer in both conversations.\n\n\`\`\`ts\n${answerCode}\n\`\`\``;

function typography(element: Locator) {
  return element.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      family: style.fontFamily,
      size: style.fontSize,
      lineHeight: style.lineHeight,
      weight: style.fontWeight,
      smoothing: style.getPropertyValue("-webkit-font-smoothing"),
    };
  });
}

suite.define(() => {
  for (const width of [1440, 390]) {
    it(`matches main-chat typography and keeps code controls usable at ${width}px`, async () => {
      await suite.withPage(
        {
          viewport: { width, height: 900 },
          permissions: ["clipboard-read", "clipboard-write"],
        },
        async ({ page }) => {
          const sessionKey = "agent:main:side-chat-typography";
          await installMockGateway(page, {
            sessionKey,
            historyMessages: [
              { role: "user", content: question },
              { role: "assistant", content: answer },
            ],
            methodResponses: {
              "config.get": {
                config: { ui: { prefs: { theme: "dash", themeMode: "dark" } } },
                hash: "side-chat-typography",
                valid: true,
              },
              "sessions.companion.state": {
                exchanges: [{ question, answer, ts: 1_000 }],
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          const main = page.locator(".chat-thread");
          await main.getByText("The same readable answer in both conversations.").waitFor();
          await openChatSidePanelType(page, "Side chat");
          const side = page.locator("openclaw-chat-session-rail");
          await side.getByText("The same readable answer in both conversations.").waitFor();
          await page.evaluate(() => document.fonts.ready);

          for (const text of [questionText, "The same readable answer in both conversations."]) {
            const expected = await typography(main.getByText(text, { exact: true }));
            expect(expected.family).toContain("Fraunces");
            expect(await typography(side.getByText(text, { exact: true }))).toEqual(expected);
          }
          // The common scale owner must affect both reading surfaces, not only the main thread.
          await page.evaluate(() =>
            document.documentElement.style.setProperty("--control-ui-text-scale", "1.25"),
          );
          expect(await typography(side.getByText(questionText, { exact: true }))).toEqual(
            await typography(main.getByText(questionText, { exact: true })),
          );
          expect(await typography(side.getByRole("textbox"))).toEqual(
            await typography(page.getByRole("textbox", { name: "Chat composer", exact: true })),
          );
          await side.getByRole("button", { name: "Copy code", exact: true }).click();
          await expect
            .poll(() => page.evaluate(() => navigator.clipboard.readText()))
            .toBe(answerCode);
          const wrap = side.locator(".code-block-wrap");
          await expect.poll(() => wrap.isVisible()).toBe(true);
          await wrap.click();
          expect(await wrap.getAttribute("aria-pressed")).toBe("true");
          expect(
            await side
              .locator(".code-block-viewport code")
              .evaluate((node) => getComputedStyle(node).whiteSpace),
          ).toBe("pre-wrap");
          // Questions use the same plain, non-collapsing code presentation as main-chat users.
          for (const surface of [main, side]) {
            const user = surface.locator(".chat-group.user");
            expect(await user.locator(".code-block-wrapper").count()).toBe(0);
            expect(await user.locator("pre code").textContent()).toContain("eight");
          }
          const thread = await side.locator(".chat-session-rail__thread").evaluate((node) => ({
            width: node.clientWidth,
            contentWidth: node.scrollWidth,
          }));
          expect(thread.contentWidth).toBeLessThanOrEqual(thread.width + 1);
        },
      );
    });
  }
});
