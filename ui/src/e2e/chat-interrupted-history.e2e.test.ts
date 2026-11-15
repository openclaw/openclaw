import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  interruptedChatHistory,
  interruptedChatCommentary,
  interruptedChatPrompt,
  interruptedChatSession,
} from "../test-helpers/interrupted-chat-history.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Interrupted chat history" });

suite.define(() => {
  it("shows saved commentary and activity after reload without a terminal assistant row", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessions: [{ key: "agent:main:main", ...interruptedChatSession }],
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
      await thread.locator(".chat-activity-group__summary").first().click();
      await thread.getByText("Inspect fixture 1", { exact: true }).waitFor();
      await page.reload();
      await thread.getByText(interruptedChatCommentary[1]!, { exact: true }).waitFor();
      await thread.getByText("Interrupted", { exact: true }).waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});
