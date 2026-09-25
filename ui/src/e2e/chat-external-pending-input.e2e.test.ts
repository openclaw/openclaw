import { expect, it } from "vitest";
import {
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("shows another client's accepted follow-up during an active turn and promotes it once", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const sessionKey = "agent:main:dashboard:external-input-proof";
        const sessionId = "external-input-proof-session";
        const runId = "active-synthetic-run";
        const startedAt = Date.now() - 10_000;
        const liveText = "Checking the current build. The active task is still running.";
        const followup = "After this task finishes, verify the new concurrency default.";
        const session = {
          key: sessionKey,
          sessionId,
          kind: "direct",
          label: "Operations coordination",
          status: "running",
          hasActiveRun: true,
          activeRunIds: [runId],
          updatedAt: startedAt,
        };
        const initial = {
          role: "user",
          content: "Check the current build and report the result.",
          timestamp: startedAt - 1_000,
          __openclaw: {
            id: "initial-user",
            seq: 1,
            idempotencyKey: `${runId}:user`,
            senderId: "synthetic-operator",
            senderName: "Example Operator",
            senderIdentity: { type: "profile", id: "synthetic-operator" },
            transport: { clients: [{ id: "openclaw-control-ui", mode: "webchat" }] },
          },
        };
        const history = {
          messages: [initial],
          pendingInputs: { items: [], total: 0 },
          inFlightRun: { runId, startedAt, text: liveText, events: [], sessionAbortable: true },
          sessionId,
          sessionInfo: session,
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessionInfo: session,
          sessions: [session],
          methodResponses: {
            "chat.startup": history,
            "chat.history": history,
            "sessions.list": chatSessionListResponse([session]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("chat.startup");
        const stream = page.locator(".chat-bubble.streaming", { hasText: liveText });
        await stream.waitFor();
        await page.getByRole("button", { name: "Stop generating" }).waitFor();
        await expect.poll(() => page.getByText(followup, { exact: true }).count()).toBe(0);

        const source = { id: "cli", mode: "cli", displayName: "Release helper" };
        const pendingMessage = {
          role: "user",
          content: followup,
          timestamp: startedAt + 500,
          __openclaw: { id: "pending:external-input", transport: { clients: [source] } },
        };
        const pending = {
          id: "external-input",
          runId: "external-follow-up",
          acceptedAt: pendingMessage.timestamp,
          state: "queued",
          message: pendingMessage,
        };
        await gateway.setMethodResponse("chat.history", {
          ...history,
          pendingInputs: { items: [pending], total: 1 },
        });
        await captureUiProof(suite, page, "external-pending-input", "01-before.png");
        const readsBefore = (await gateway.getRequests("chat.history")).length;
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          agentId: "main",
          reason: "send",
          hasActiveRun: true,
          activeRunIds: [runId],
        });
        await expect
          .poll(async () => (await gateway.getRequests("chat.history")).length)
          .toBeGreaterThan(readsBefore);
        await expect.poll(() => page.getByText(followup, { exact: true }).count()).toBe(1);
        const externalGroup = page.locator(".chat-group.user", { hasText: followup });
        await captureUiProof(suite, page, "external-pending-input", "02-after.png");
        await externalGroup.getByText("via CLI (Release helper)", { exact: true }).waitFor();
        expect(
          await externalGroup
            .locator(".chat-sender-name, .chat-avatar, .chat-author-avatar")
            .count(),
        ).toBe(0);
        expect(await stream.isVisible()).toBe(true);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);

        const promoted = {
          ...pendingMessage,
          __openclaw: {
            id: "external-input",
            seq: 2,
            idempotencyKey: "external-follow-up:user",
            transport: { clients: [source] },
          },
        };
        await gateway.setMethodResponse("chat.history", {
          ...history,
          messages: [initial, promoted],
        });
        const promotionReadsBefore = (await gateway.getRequests("chat.history")).length;
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          agentId: "main",
          session,
          hasActiveRun: true,
          activeRunIds: [runId],
          message: promoted,
          messageId: "external-input",
          messageSeq: 2,
        });
        await expect
          .poll(async () => (await gateway.getRequests("chat.history")).length)
          .toBeGreaterThan(promotionReadsBefore);
        await expect.poll(() => page.getByText(followup, { exact: true }).count()).toBe(1);
        expect(await externalGroup.locator(".chat-message-source").textContent()).toBe(
          "via CLI (Release helper)",
        );
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await captureUiProof(suite, page, "external-pending-input", "03-promoted.png");
      },
    );
  });
});
