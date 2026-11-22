import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Social browser results" });
const url = "https://x.com/openclaw/status/1234567890123456789";

suite.define(() => {
  it("does not create a social card just because the agent visits a post", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        automaticallyFetchFavicons: true,
        historyMessages: [
          { role: "user", content: "Inspect the post.", timestamp: 1000 },
          {
            role: "toolResult",
            timestamp: 2000,
            toolCallId: "tweet",
            toolName: "browser",
            content: "Inspected the post.",
            details: {
              browserTab: { target: "host", profile: "managed", targetId: "tweet-tab", url },
            },
          },
          { role: "assistant", content: "The post was checked.", timestamp: 3000 },
        ],
      });
      await page.goto(suite.server.baseUrl + "chat");
      await page.getByText("The post was checked.", { exact: true }).waitFor();
      for (const selector of [".chat-activity-group__summary", ".chat-tool-msg-summary"]) {
        for (const summary of await page.locator(selector).all()) {
          if ((await summary.getAttribute("aria-expanded")) !== "true") {
            await summary.click();
          }
        }
      }
      await page.getByText("Inspected the post.", { exact: true }).waitFor();
      expect(await page.locator("openclaw-browser-tab-card").count()).toBe(0);
      expect(await gateway.getRequests("controlUi.linkPreview")).toHaveLength(0);
      expect(await gateway.getRequests("browser.request")).toHaveLength(0);
    });
  });
});
