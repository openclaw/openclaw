import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "side-chat typography" });
const questionText = "What changed?";
const question = `${questionText}\n\n\`\`\`text\none\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n\`\`\``;
const answerCode = `const detail = "${"A long line in a narrow side chat. ".repeat(6)}";`;
const answerText = "The same readable answer in both conversations.";
const answer = `${answerText}\n\n\`\`\`ts\n${answerCode}\n\`\`\``;

function typography(element: Locator) {
  return element.evaluate((node) => {
    const style = getComputedStyle(node);
    return ["font-family", "font-size", "line-height", "font-weight", "-webkit-font-smoothing"].map(
      (field) => style.getPropertyValue(field),
    );
  });
}

suite.define(() => {
  it.each([1440, 390])("matches typography and code controls at %ipx", async (width) => {
    const permissions = ["clipboard-read", "clipboard-write"];
    await suite.withPage({ viewport: { width, height: 900 }, permissions }, async ({ page }) => {
      const sessionKey = "agent:main:side-chat-typography";
      await installMockGateway(page, {
        sessionKey,
        historyMessages: [
          { role: "user", content: question },
          { role: "assistant", content: answer },
        ],
        methodResponses: {
          "config.get": themeConfigResponse("dash", "dark"),
          "sessions.companion.state": {
            exchanges: [{ question, answer, ts: 1_000 }],
          },
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const main = page.locator(".chat-thread");
      await main.getByText(answerText).waitFor();
      await openChatSidePanelType(page, "Side chat");
      const side = page.locator("openclaw-chat-session-rail");
      await side.getByText(answerText).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const textStyle = (surface: Locator, text: string) =>
        typography(surface.getByText(text, { exact: true }));
      for (const text of [questionText, answerText]) {
        const expected = await textStyle(main, text);
        expect(expected[0]).toContain("Fraunces");
        expect(await textStyle(side, text)).toEqual(expected);
      }
      await page.evaluate(() =>
        document.documentElement.style.setProperty("--control-ui-text-scale", "1.25"),
      );
      expect(await textStyle(side, questionText)).toEqual(await textStyle(main, questionText));
      const composer = page.locator(".agent-chat__composer-shell textarea");
      expect(await typography(side.getByRole("textbox"))).toEqual(await typography(composer));
      await side.getByRole("button", { name: "Copy code", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(answerCode);
      const wrap = side.locator(".code-block-wrap");
      await expect.poll(() => wrap.isVisible()).toBe(true);
      await wrap.click();
      expect(await wrap.getAttribute("aria-pressed")).toBe("true");
      const code = side.locator(".code-block-viewport code");
      expect(await code.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe("pre-wrap");
      for (const surface of [main, side]) {
        const user = surface.locator(".chat-group.user");
        expect(await user.locator(".code-block-wrapper").count()).toBe(0);
        expect(await user.locator("pre code").textContent()).toContain("eight");
      }
      const overflow = await side
        .locator(".chat-session-rail__thread")
        .evaluate((node) => node.scrollWidth - node.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });
  });
});
