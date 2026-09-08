import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI browser preview URLs" });

suite.define(() => {
  it("hides blank-tab previews while retaining HTTPS cards and the original result", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark", serviceWorkers: "block" },
      async ({ page }) => {
        await installMockGateway(page, {
          historyMessages: [
            { role: "user", content: "Open both pages.", timestamp: 1_000 },
            ...["about:blank", "https://example.com"].flatMap((url, index) => [
              {
                role: "assistant",
                timestamp: 2_000 + index * 1_000,
                content: [
                  {
                    type: "toolCall",
                    id: `open-${index}`,
                    name: "browser",
                    arguments: { action: "open", url },
                  },
                ],
              },
              {
                role: "toolResult",
                toolCallId: `open-${index}`,
                toolName: "browser",
                timestamp: 2_500 + index * 1_000,
                content: [{ type: "text", text: `Opened ${url}` }],
                details: {
                  browserTab: { target: "host", profile: "managed", targetId: `tab-${index}`, url },
                },
              },
            ]),
            {
              role: "assistant",
              content: "Ready. A plain link: https://example.org",
              timestamp: 5_000,
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.getByText("Ready. A plain link:", { exact: false }).waitFor();
        const cards = page.locator("openclaw-browser-tab-card");
        await expect.poll(() => cards.count()).toBe(1);
        expect(await cards.locator(".url").textContent()).toBe("https://example.com");
        for (const selector of [".chat-activity-group__summary", ".chat-tool-msg-summary"]) {
          for (const summary of await page.locator(selector).all()) {
            if ((await summary.getAttribute("aria-expanded")) !== "true") {
              await summary.click();
            }
          }
        }
        await page.getByText("Opened about:blank", { exact: true }).waitFor();
        expect(await cards.count()).toBe(1);
      },
    );
  });
});
