import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("finds recovered reply text and keeps it when transcript search is cleared", async () => {
    const artifactDir = createControlUiE2eArtifactDir("chat-recovered-search");
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const sessionKey = "agent:main:recovered-search";
      const messageId = "recovered-search-answer";
      const keyword = "lunarneedle";
      const fullText = `# Museum inventory\n\nThe restored exhibit is ${keyword}.`;
      const gateway = await installMockGateway(page, {
        sessionKey,
        deferredMethods: ["chat.message.get"],
        historyMessages: [
          {
            role: "user",
            content: "Prepare the museum inventory.",
            timestamp: 1_800_000_000_000,
            __openclaw: { id: "recovered-search-prompt", seq: 1 },
          },
          {
            role: "assistant",
            content: "Museum inventory preview\n...(truncated)...",
            timestamp: 1_800_000_000_001,
            __openclaw: { id: messageId, seq: 2, truncated: true },
          },
        ],
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const pane = page.locator(".chat-pane-cache__pane--active");
      const reply = pane.locator(`.chat-bubble[data-entry-id="${messageId}"]`);
      const prompt = pane.locator('.chat-bubble[data-entry-id="recovered-search-prompt"]');
      await prompt.waitFor({ state: "visible" });
      const request = await gateway.waitForRequest("chat.message.get");
      expect(request.params).toMatchObject({ sessionKey, messageId });
      await expect.poll(() => reply.textContent()).toContain("Museum inventory preview");
      await gateway.resolveDeferred("chat.message.get", {
        ok: true,
        message: { role: "assistant", content: fullText },
      });
      await expect.poll(() => reply.textContent()).toContain(keyword);
      await page.screenshot({ path: path.join(artifactDir, "recovered.png") });

      const composer = pane.locator(".agent-chat__composer-combobox openclaw-composer-editor");
      await composer.locator(".cm-content").focus();
      const shortcut = await page.evaluate(() =>
        /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+f" : "Control+f",
      );
      await page.keyboard.press(shortcut);
      const search = pane.getByRole("textbox", { name: "Search messages", exact: true });
      await search.fill(keyword);
      // The unrelated prompt leaving the DOM proves the filter has committed.
      await expect.poll(() => prompt.count()).toBe(0);
      const filteredReplyTexts = await reply.allTextContents();
      await page.screenshot({ path: path.join(artifactDir, "search.png") });

      await pane.getByRole("button", { name: "Close search", exact: true }).click();
      await expect.poll(() => reply.textContent()).toContain(keyword);
      expect(await search.count()).toBe(0);
      expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
      expect(await gateway.getRequests("chat.message.get")).toHaveLength(1);
      await page.screenshot({ path: path.join(artifactDir, "cleared.png") });
      await writeFile(
        path.join(artifactDir, "result.json"),
        JSON.stringify(
          { keyword, filteredReplyTexts, restoredText: await reply.textContent() },
          null,
          2,
        ),
      );

      expect(filteredReplyTexts.join("\n")).toContain(keyword);
    });
  });
});
