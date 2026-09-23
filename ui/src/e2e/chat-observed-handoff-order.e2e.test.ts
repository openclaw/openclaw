import { expect, it } from "vitest";
import {
  captureUiProof,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps an observed cancelled handoff before a new composer message and its saved row", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const sessionKey = "agent:main:dashboard:handoff-order-proof";
        const sessionId = "handoff-order-proof-session";
        const handoffText = "The handoff is ready. The next step is to verify the result.";
        const prompt = "Continue from the handoff and verify the result.";
        const now = Date.now();
        const session = {
          key: sessionKey,
          sessionId,
          kind: "direct",
          label: "Handoff ordering",
          status: "idle",
          hasActiveRun: false,
          updatedAt: now,
        };
        const messages = [
          {
            role: "user",
            content: "Prepare the work for a handoff.",
            timestamp: now - 20_000,
            __openclaw: { id: "earlier-request", seq: 1 },
          },
          {
            role: "assistant",
            content: "The current work is complete.",
            timestamp: now - 10_000,
            __openclaw: { id: "earlier-reply", seq: 2 },
          },
        ];
        const pendingInputs = {
          total: 1,
          items: [
            {
              id: "earlier-handoff",
              runId: "earlier-handoff-run",
              acceptedAt: now - 100_000,
              state: "cancelled",
              message: {
                role: "assistant",
                content: handoffText,
                timestamp: now - 100_000,
                provenance: { kind: "inter_session", sourceTool: "sessions_send" },
                senderSession: { sessionKey: "agent:helper:main", agentId: "helper" },
                __openclaw: { id: "pending:earlier-handoff" },
              },
            },
          ],
        };
        const history = { messages, pendingInputs, sessionId, sessionInfo: session };
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessionInfo: session,
          sessions: [session],
          methodResponses: { "chat.startup": history, "chat.history": history },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByText(handoffText, { exact: true }).waitFor();
        await captureUiProof(suite, page, "observed-handoff-order", "01-before-send.png");
        await gateway.deferNext("chat.send");
        await page.getByRole("textbox", { name: "Chat composer", exact: true }).fill(prompt);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = (send.params as { idempotencyKey: string }).idempotencyKey;
        expect(runId).toBeTruthy();
        await page.getByText(prompt, { exact: true }).waitFor();
        const handoffPrecedesUser = async () => {
          const groups = await page.locator(".chat-group").allTextContents();
          const handoffIndex = groups.findIndex((text) => text.includes(handoffText));
          const userIndex = groups.findIndex((text) => text.includes(prompt));
          return handoffIndex >= 0 && userIndex > handoffIndex;
        };
        const submittingOrder = await handoffPrecedesUser();
        await captureUiProof(suite, page, "observed-handoff-order", "02-submitting.png");
        const canonicalUser = {
          role: "user",
          content: prompt,
          timestamp: now + 1_000,
          __openclaw: {
            id: "next-request",
            seq: 3,
            runId,
            idempotencyKey: `${runId}:user`,
          },
        };
        await gateway.setMethodResponse("chat.history", {
          ...history,
          messages: [...messages, canonicalUser],
        });
        await gateway.resolveDeferred("chat.send", { runId, status: "started", messageSeq: 3 });
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          agentId: "main",
          session,
          message: canonicalUser,
          messageId: "next-request",
          messageSeq: 3,
        });
        await expect.poll(() => page.getByText(prompt, { exact: true }).count()).toBe(1);
        await expect.poll(() => page.locator(".chat-send-status").count()).toBe(0);
        await captureUiProof(suite, page, "observed-handoff-order", "03-persisted.png");
        expect(submittingOrder).toBe(true);
        await expect.poll(handoffPrecedesUser).toBe(true);
        expect(await page.getByText(handoffText, { exact: true }).count()).toBe(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);
      },
    );
  });
});
