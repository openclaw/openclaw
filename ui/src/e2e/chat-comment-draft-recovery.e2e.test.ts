import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { captureUiProof, waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Unsent highlight comment recovery" });
const passage = "Review the deployment checklist before the release.";

async function reloadAfterCommentSave(page: Page) {
  // A visible edit is not a durable receipt. The UI owns the pending-save
  // indicator and reload guard; require an actual new document after it settles.
  await page.locator(".chat-session-rail__save-status").waitFor({ state: "hidden" });
  const navigated = page.waitForEvent("framenavigated", (frame) => frame === page.mainFrame());
  await page.reload();
  await navigated;
}

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
        await chip.waitFor({ state: "visible" });
        expect(await chip.textContent()).toContain("1");
        await reloadAfterCommentSave(page);
        await chip.waitFor({ state: "visible" });
        expect(await chip.textContent()).toContain("1");
        await chip.click();
        const list = page.locator(".chat-comment-preview__list");
        await list.getByText("Confirm the checklist owner.", { exact: true }).waitFor();
        await list.getByText(passage, { exact: true }).waitFor();
        await list.getByRole("button", { name: "Edit comment 1", exact: true }).click();
        await input.fill("Confirm the revised checklist owner.");
        await input.press("Enter");
        // Saving restores focus without reopening the preview.
        await expect
          .poll(() =>
            chip
              .locator(".chat-selection-annotations__trigger")
              .evaluate((element) => document.activeElement === element),
          )
          .toBe(true);
        await chip.click();
        await list.getByText("Confirm the revised checklist owner.", { exact: true }).waitFor();
        await reloadAfterCommentSave(page);
        await chip.click();
        await list.getByText("Confirm the revised checklist owner.", { exact: true }).waitFor();
        await list.getByRole("button", { name: "Delete comment", exact: true }).click();
        await chip.waitFor({ state: "hidden" });
        expect(await chip.count()).toBe(0);
        await reloadAfterCommentSave(page);
        await source.waitFor();
        expect(await chip.count()).toBe(0);
      },
    );
  });
  it("restores main-chat selection comments as visible inline pins with the same highlighted source", async () => {
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
          .getByRole("button", { name: "Add to chat", exact: true })
          .click();
        const editor = page.getByRole("dialog", { name: "Comment", exact: true });
        const comment = "Keep this main-chat inline comment.";
        await editor.getByRole("textbox").fill(comment);
        await editor.getByRole("textbox").press("Enter");
        await editor.waitFor({ state: "hidden" });
        const pin = page.locator(".chat-thread .chat-comment-pin");
        await pin.waitFor({ state: "visible" });
        expect(await pin.count()).toBe(1);
        await pin.click();
        await editor.waitFor({ state: "visible" });
        expect(await editor.getByRole("textbox").inputValue()).toBe(comment);
        const highlight = () =>
          page.evaluate(() =>
            Array.from(CSS.highlights.get("openclaw-comment") ?? [], (highlighted) => {
              const range = document.createRange();
              range.setStart(highlighted.startContainer, highlighted.startOffset);
              range.setEnd(highlighted.endContainer, highlighted.endOffset);
              return range.toString();
            }),
          );
        expect(await highlight()).toEqual([passage]);
        await captureUiProof(suite, page, "main-inline", "before-document-reload.png");
        await page.keyboard.press("Escape");
        await editor.waitFor({ state: "hidden" });
        await reloadAfterCommentSave(page);
        await pin.waitFor({ state: "visible" });
        expect(await pin.count()).toBe(1);
        await pin.click();
        await editor.waitFor({ state: "visible" });
        expect(await editor.getByRole("textbox").inputValue()).toBe(comment);
        expect(await highlight()).toEqual([passage]);
      },
    );
  });
});
