import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  emptyAssistantAcknowledgment,
  emptyAssistantHistory,
} from "../test-helpers/empty-assistant-history.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat without assistant text" });

suite.define(() => {
  it("shows tool activity and a message wait without an empty assistant reply", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:slack:group:empty-reply",
        assistantName: "Roboclaw",
        sessions: [
          {
            key: "agent:main:slack:group:empty-reply",
            kind: "group",
            label: "Parent session conversation",
            updatedAt: 4_100,
          },
        ],
        historyMessages: emptyAssistantHistory(),
      });
      await page.goto(
        `${suite.server.baseUrl}chat?session=agent%3Amain%3Aslack%3Agroup%3Aempty-reply`,
      );
      await gateway.waitForRequest("chat.startup");
      const thread = page.locator(".chat-thread");
      const prompt = thread.getByText("talk to parent session", { exact: true });
      await prompt.waitFor();
      await thread.locator(".chat-tool-row, .chat-activity-group__summary").first().waitFor();
      const frame = await takeControlUiScreenshotFrame(page, thread, [prompt], {
        animations: "disabled",
      });
      const screenshot = path.join(suite.artifactDir, "chat.png");
      await writeFile(screenshot, frame.png);
      console.log(`Screenshot: ${screenshot}`);
      expect(await thread.locator(".chat-group.assistant").count()).toBe(0);
      await thread.getByText(emptyAssistantAcknowledgment, { exact: true }).waitFor();
      expect(await thread.textContent()).not.toContain("PRIVATE_CONTINUATION");
    });
  });
});
