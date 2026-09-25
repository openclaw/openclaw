import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

async function captureProof(page: Page, fileName: string): Promise<void> {
  await captureUiProof(suite, page, "markdown-progress-adversarial", fileName);
}

suite.define(() => {
  it("keeps an adversarial progress payload responsive through a Gateway refresh", async () => {
    const now = Date.now();
    const selectedSessionKey = "agent:main:adversarial-selected";
    const sessionKey = "agent:main:adversarial-progress";
    const cardResponse = (markdown: string, revision: number) => ({
      card: {
        markdown,
        revision,
        sessionKey,
        steps: [
          { step: "Inspect", status: "completed" },
          { step: "Render", status: revision === 1 ? "in_progress" : "completed" },
          { step: "Refresh", status: revision === 1 ? "pending" : "in_progress" },
        ],
        updatedAt: now,
      },
    });

    await suite.withPage(
      {
        colorScheme: "dark",
        hasTouch: false,
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
          methodResponses: {
            "progressCard.get": {
              cases: [
                { match: { sessionKey: selectedSessionKey }, response: { card: null } },
                {
                  match: { sessionKey },
                  response: cardResponse(
                    `Adversarial payload rendered\n\n${"<script>".repeat(17_500)}`,
                    1,
                  ),
                },
              ],
            },
            "sessions.list": chatSessionListResponse([
              {
                key: selectedSessionKey,
                kind: "direct",
                label: "Selected session",
                updatedAt: now,
              },
              {
                key: sessionKey,
                kind: "direct",
                label: "Adversarial progress",
                updatedAt: now - 1,
              },
            ]),
          },
          sessionKey: selectedSessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, selectedSessionKey));
        const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
        await row.waitFor({ state: "visible" });
        const renderStartedAt = performance.now();
        await row.hover();
        const card = page.locator(".session-progress-hovercard");
        await card.waitFor({ state: "visible" });
        await expect.poll(() => card.textContent()).toContain("Adversarial payload rendered");
        expect(performance.now() - renderStartedAt).toBeLessThan(2_000);
        await captureProof(page, "adversarial-payload-rendered.png");

        await gateway.setMethodResponse(
          "progressCard.get",
          cardResponse(
            '**Responsive after refresh**\n\n<progress value="7" max="7"></progress>',
            2,
          ),
        );
        const refreshStartedAt = performance.now();
        await gateway.emitGatewayEvent("progressCard.changed", { revision: 2, sessionKey });
        await expect.poll(() => card.textContent()).toContain("Responsive after refresh");
        expect(performance.now() - refreshStartedAt).toBeLessThan(1_000);
        await captureProof(page, "adversarial-payload-refreshed.png");
      },
    );
  });
});
