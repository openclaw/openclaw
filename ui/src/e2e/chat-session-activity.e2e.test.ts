import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("resolves a collapsed source title and opens original receipts with one click or keyboard", async () => {
    const sessionKey = "agent:main:activity-reader";
    const sourceKey = "agent:main:activity-source";
    const sourceLabel = "Verification session";
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        await installMockGateway(page, {
          sessionKey,
          sessions: [
            { key: sessionKey, kind: "direct", displayName: "Reader", updatedAt: 1 },
            { key: sourceKey, kind: "direct", displayName: sourceLabel, updatedAt: 1 },
          ],
          historyMessages: [1, 2, 3].map((seq) => ({
            role: "assistant",
            timestamp: 1000 + seq,
            content:
              "Receipt " +
              seq +
              ": " +
              "Verification detail. ".repeat(100) +
              "End of receipt " +
              seq,
            provenance: {
              kind: "inter_session",
              sourceTool: "sessions_send",
              sourceSessionKey: sourceKey,
            },
            // Ordinary sends carry source identity, not a pre-resolved session title.
            senderSession: { sessionKey: sourceKey, agentId: "main" },
            __openclaw: { id: "receipt-" + seq, seq, runId: "run-" + seq, turnBoundary: true },
          })),
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const activity = page.locator(".chat-session-activity");
        const summary = activity.locator("summary");
        await summary.getByText(sourceLabel, { exact: true }).waitFor();
        expect(await activity.count()).toBe(1);
        expect(await summary.locator("a").count()).toBe(0);
        expect(await activity.locator(".chat-bubble").count()).toBe(0);
        await summary.click();
        await activity.getByText(/End of receipt 3$/).waitFor();
        expect(await activity.locator(".chat-reply-attribution").count()).toBe(1);
        expect(await summary.getByText("From", { exact: true }).count()).toBe(1);
        expect(await summary.getByText("3 updates from", { exact: true }).count()).toBe(0);
        expect(
          await activity.locator(".chat-session-activity__body .chat-reply-attribution").count(),
        ).toBe(0);
        expect(await activity.locator(".chat-message-disclosure__toggle").count()).toBe(0);
        await summary.focus();
        await summary.press("Enter");
        await activity.getByText(/End of receipt 3$/).waitFor({ state: "detached" });
        await summary.press("Space");
        await activity.getByText(/End of receipt 3$/).waitFor();
        await activity.locator("a[data-session-key]").click();
        await page.waitForURL((url) => url.pathname.includes("activity-source"));
      },
    );
  });
});
