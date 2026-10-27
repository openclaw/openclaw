import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Unsent highlight comment recovery" });
const passage = "Review the deployment checklist before the release.";

suite.define(() => {
  it("restores a comment-only side-chat draft after reloading and preserves edits and removal", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, locale: "en-US" },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: passage }],
        });
        await page.goto(suite.server.baseUrl + "chat");
        const source = page
          .locator(".chat-group.assistant .chat-text p")
          .filter({ hasText: passage });
        await source.waitFor();
        await waitForChatScrollIdle(page);
        await source.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(range);
        });
        await source.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
        await page
          .getByRole("toolbar", { name: "Selection actions" })
          .getByRole("button", { name: "Ask in side chat", exact: true })
          .click();
        const input = page
          .getByRole("dialog", { name: "Comment", exact: true })
          .getByRole("textbox");
        await input.fill("Confirm the checklist owner.");
        await input.press("Enter");
        const chip = page.locator(".chat-selection-annotations__chip");
        await expect.poll(() => chip.textContent()).toContain("1");
        await page.reload();
        await expect.poll(() => chip.textContent()).toContain("1");
        await chip.click();
        const list = page.locator(".chat-comment-preview__list");
        await expect.poll(() => list.textContent()).toContain("Confirm the checklist owner.");
        await expect.poll(() => list.textContent()).toContain(passage);
        await list.getByRole("button", { name: "Edit comment 1", exact: true }).click();
        await input.fill("Confirm the revised checklist owner.");
        await input.press("Enter");
        await expect
          .poll(() => list.textContent())
          .toContain("Confirm the revised checklist owner.");
        await page.reload();
        await chip.click();
        await expect
          .poll(() => list.textContent())
          .toContain("Confirm the revised checklist owner.");
        await list.getByRole("button", { name: "Delete comment", exact: true }).click();
        await expect.poll(() => chip.count()).toBe(0);
        await page.reload();
        await source.waitFor();
        expect(await chip.count()).toBe(0);
      },
    );
  });
});
