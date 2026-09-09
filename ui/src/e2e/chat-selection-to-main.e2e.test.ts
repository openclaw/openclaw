import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI selected text destinations" });
const selectedText = "Review the deployment checklist.";
const quote = `Regarding "${selectedText}": `;

suite.define(() => {
  it.each([
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ])("adds a quote without sending or replacing the draft at $width px", async (viewport) => {
    await suite.withPage(
      { viewport, locale: "en-US", reducedMotion: "reduce", serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: selectedText }],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.waitFor({ state: "visible" });
        const text = page.locator(".chat-bubble .chat-text p").filter({ hasText: selectedText });
        const popup = page.getByRole("toolbar", { name: "Selection actions" });
        const select = async () => {
          await text.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
          });
          await text.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
          await popup.waitFor({ state: "visible" });
        };

        for (const draft of ["", "Please explain the next step."]) {
          await composer.fill(draft);
          await select();
          expect(await popup.getByRole("button").allTextContents()).toEqual([
            "Add to chat",
            "Ask in side chat",
          ]);
          const bounds = await popup.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
          await popup.getByRole("button", { name: "Add to chat", exact: true }).click();
          await expect
            .poll(() => composer.inputValue())
            .toBe(draft ? `${draft}\n\n${quote}` : quote);
          expect(await composer.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );
          expect(await popup.count()).toBe(0);
          expect(await page.locator(".chat-session-rail__input").count()).toBe(0);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        }

        const mainDraft = await composer.inputValue();
        await select();
        await page.keyboard.press("Escape");
        expect(await popup.count()).toBe(0);
        await select();
        await popup.getByRole("button", { name: "Ask in side chat", exact: true }).click();
        const sideComposer = page.locator(".chat-session-rail__input");
        await sideComposer.waitFor({ state: "visible" });
        expect(await sideComposer.inputValue()).toBe(quote);
        expect(await composer.inputValue()).toBe(mainDraft);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
