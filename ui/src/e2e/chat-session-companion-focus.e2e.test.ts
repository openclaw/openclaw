import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "side-chat input focus" });

suite.define(() => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    it(`focuses Side chat on open, reopen, and tab activation at ${viewport.width}px`, async () => {
      await suite.withPage({ viewport }, async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}chat`);
        await openChatSidePanelType(page, "Side chat");
        const input = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
        await expect
          .poll(() => input.evaluate((element) => document.activeElement === element))
          .toBe(true);
        await page.keyboard.type("Ready to ask");
        expect(await input.inputValue()).toBe("Ready to ask");

        await page.locator(".side-panel__minimize").click();
        await page.locator(".chat-side-panel-toggle").click();
        await expect
          .poll(() => input.evaluate((element) => document.activeElement === element))
          .toBe(true);
        expect(await input.inputValue()).toBe("Ready to ask");

        await openChatSidePanelType(page, "Tasks");
        await page.getByRole("tab", { name: "Side chat", exact: true }).click();
        await expect
          .poll(() => input.evaluate((element) => document.activeElement === element))
          .toBe(true);
        await page.keyboard.type(" again");
        expect(await input.inputValue()).toBe("Ready to ask again");
      });
    });
  }

  it("does not steal focus back when the side-chat history finishes loading", async () => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.companion.state"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.companion.state");
      await openChatSidePanelType(page, "Side chat");
      const input = page.getByRole("textbox", { name: "Ask in side chat", exact: true });
      await expect
        .poll(() => input.evaluate((element) => document.activeElement === element))
        .toBe(true);
      const mainInput = page.locator(".agent-chat__composer-combobox textarea");
      await mainInput.fill("Keep typing here");
      await gateway.resolveDeferred("sessions.companion.state", {
        exchanges: [{ question: "What changed?", answer: "The introduction is ready.", ts: 1 }],
      });
      await page.getByText("The introduction is ready.", { exact: true }).waitFor();
      expect(await mainInput.evaluate((element) => document.activeElement === element)).toBe(true);
      await page.keyboard.type(".");
      expect(await mainInput.inputValue()).toBe("Keep typing here.");
    });
  });
});
