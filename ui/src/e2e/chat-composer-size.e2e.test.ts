import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI session composer size" });

suite.define(() => {
  it("keeps existing sessions compact without shrinking new-chat or multiline drafts", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        historyMessages: [
          { role: "assistant", content: "Ready for a follow-up.", timestamp: 1000 },
        ],
      });
      await page.goto(`${suite.server.baseUrl}new`);
      const newComposer = page.locator(".new-session-page__composer");
      await expect
        .poll(() => newComposer.evaluate((element) => element.getBoundingClientRect().height))
        .toBe(112);

      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Ready for a follow-up.", { exact: true }).waitFor();
      const composer = page.locator(".chat-footer .agent-chat__input");
      const editor = composer.locator("textarea");
      const height = () => composer.evaluate((element) => element.getBoundingClientRect().height);
      // The content keeps its own editor and control spacing above the 88px floor.
      await expect.poll(height).toBeLessThanOrEqual(96);
      const compactHeight = await height();
      expect(compactHeight).toBeGreaterThanOrEqual(88);
      await editor.fill("A short follow-up");
      await expect.poll(height).toBe(compactHeight);
      await editor.fill(
        "A longer follow-up\nwith several lines\nthat needs more space\nwithout clipping.",
      );
      await expect.poll(height).toBeGreaterThan(compactHeight);
      expect(await editor.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(
        true,
      );
      await editor.fill("");
      await expect.poll(height).toBe(compactHeight);

      await page.setViewportSize({ width: 390, height: 844 });
      await editor.fill("A mobile follow-up");
      const send = composer.getByRole("button", { name: "Send message", exact: true });
      await send.waitFor({ state: "visible" });
      const composerBox = await composer.boundingBox();
      const sendBox = await send.boundingBox();
      expect(composerBox).not.toBeNull();
      expect(sendBox).not.toBeNull();
      if (!composerBox || !sendBox) {
        throw new Error("Expected visible composer and send control");
      }
      expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(composerBox.x + composerBox.width);
      expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(composerBox.y + composerBox.height);
      expect(await editor.evaluate((element) => getComputedStyle(element).fontSize)).toBe("16px");
    });
  });
});
