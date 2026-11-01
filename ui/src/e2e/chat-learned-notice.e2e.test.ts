import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { polledAttribute, polledVisible } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Learned notice answer preservation" });

suite.define(() => {
  it.each(["marked", "legacy"] as const)(
    "keeps the answer outside Worked when a late %s notice arrives and after reload",
    async (format) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const sessionKey = "agent:main:dashboard:learned-answer";
        const answerText = "Staging is healthy. All 12 checks passed; production is unchanged.";
        const history: unknown[] = [
          { role: "user", content: "Check staging and summarize the result.", timestamp: 1000 },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "check", name: "read", arguments: { path: "checks.txt" } },
            ],
            timestamp: 2000,
            __openclaw: { runId: "check-run" },
          },
          {
            role: "toolResult",
            toolCallId: "check",
            toolName: "read",
            content: "12 passed, 0 failed.",
            timestamp: 3000,
            __openclaw: { runId: "check-run" },
          },
          {
            role: "assistant",
            content: answerText,
            stopReason: "stop",
            timestamp: 4000,
            __openclaw: { id: "answer", runId: "check-run" },
          },
        ];
        const text =
          '💾 Learned: updated staging-checks (check rollback); created release-summary (report checks). Say "undo" to revert this skill change.';
        const notice = {
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          api: "openclaw-transcript",
          stopReason: "stop",
          timestamp: 5000,
          content: [{ type: "text", text }],
          idempotencyKey: "skill-workshop-notice:review-run",
          __openclaw: { id: "learned", idempotencyKey: "skill-workshop-notice:review-run" },
          ...(format === "marked"
            ? {
                openclawDeliveryMirror: {
                  kind: "skill-workshop-change",
                  agentId: "main",
                  runId: "review-run",
                  skills: [
                    { name: "staging-checks", action: "updated", summary: "check rollback" },
                    { name: "release-summary", action: "created", summary: "report checks" },
                  ],
                },
              }
            : {}),
        };
        const gateway = await installMockGateway(page, { sessionKey, historyMessages: history });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const answer = pane.getByText(answerText, { exact: true });
        const worked = pane.locator(".chat-work-group > .chat-activity-group__summary");
        const noticeText = (name: string) =>
          pane
            .locator(".chat-bubble, .chat-notice, .chat-skill-notice")
            .getByText(name, { exact: false });
        await answer.waitFor();
        await polledAttribute(worked, "aria-expanded").toBe("false");
        const persisted = [...history, notice];
        await gateway.setHistoryMessages(persisted);
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          messageId: "learned",
          message: notice,
        });
        for (const reload of [false, true]) {
          if (reload) {
            await installMockGateway(page, { sessionKey, historyMessages: persisted });
            await page.reload();
          }
          await noticeText("staging-checks").waitFor();
          await polledVisible(answer).toBe(true);
          for (const expanded of [true, false]) {
            await worked.click();
            await polledAttribute(worked, "aria-expanded").toBe(String(expanded));
            expect(await answer.isVisible()).toBe(true);
            expect(await noticeText("release-summary").isVisible()).toBe(true);
            expect(
              await answer.locator("xpath=ancestor::*[contains(@class,'chat-work-group')]").count(),
            ).toBe(0);
          }
        }
      });
    },
  );
});
