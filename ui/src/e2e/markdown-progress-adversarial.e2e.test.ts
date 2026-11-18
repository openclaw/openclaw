import { expect, it } from "vitest";
import {
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps an adversarial progress payload responsive through a Gateway refresh", async () => {
    const now = Date.now();
    const selectedSessionKey = "agent:main:adversarial-selected";
    const sessionKey = "agent:main:adversarial-progress";
    const session = (key: string, label: string, updatedAt: number) => ({
      key,
      label,
      updatedAt,
      kind: "direct",
    });
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
      { ...createControlUiE2eContextOptions(), colorScheme: "dark", hasTouch: false },
      async ({ page }) => {
        const captureProof = (fileName: string) =>
          captureUiProof(suite, page, "markdown-progress-adversarial", fileName);
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
              session(selectedSessionKey, "Selected session", now),
              session(sessionKey, "Adversarial progress", now - 1),
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
        await captureProof("adversarial-payload-rendered.png");

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
        await captureProof("adversarial-payload-refreshed.png");
      },
    );
  });
});
