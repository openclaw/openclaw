import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  interruptedChatHistory,
  interruptedChatCommentary,
  interruptedChatPrompt,
} from "../test-helpers/interrupted-chat-history.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Interrupted chat history" });

suite.define(() => {
  it("shows saved commentary and activity after reload without a terminal assistant row", async () => {
    const artifacts = createControlUiE2eArtifactDir("history", ".artifacts/restart-abort-ui");
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: { "chat.history": interruptedChatHistory() },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.messages.subscribe");
      const thread = page.locator(".chat-thread");
      await thread.getByText(interruptedChatPrompt, { exact: true }).waitFor();
      for (const text of interruptedChatCommentary) {
        await thread.getByText(text, { exact: true }).waitFor();
      }
      await thread.getByText("Interrupted", { exact: true }).waitFor();
      await thread.locator(".chat-activity-group__summary").first().waitFor();
      const frame = await takeControlUiScreenshotFrame(
        page,
        thread,
        [
          thread.getByText(interruptedChatPrompt, { exact: true }),
          ...interruptedChatCommentary.map((text) => thread.getByText(text, { exact: true })),
          thread.getByText("Interrupted", { exact: true }),
        ],
        { animations: "disabled" },
      );
      await writeFile(path.join(artifacts, "history.png"), frame.png);
      await thread.locator(".chat-activity-group__summary").first().click();
      await thread.getByText("Inspect fixture 1", { exact: true }).waitFor();
      await page.reload();
      await thread.getByText(interruptedChatCommentary[1]!, { exact: true }).waitFor();
      await thread.getByText("Interrupted", { exact: true }).waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
