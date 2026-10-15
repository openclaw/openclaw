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
  it("keeps interrupted agent updates distinct from unsent human messages", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const sessionKey = "agent:main:dashboard:agent-update-proof";
        const sessionId = "agent-update-proof-session";
        const session = {
          key: sessionKey,
          sessionId,
          kind: "direct",
          label: "Mobile layout",
          status: "done",
          updatedAt: 1_000,
        };
        const update = {
          role: "user",
          content: "Verification passed on phone and desktop. Ready to land.",
          timestamp: 1_000,
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
          senderSession: {
            sessionKey: "agent:main:dashboard:verification",
            agentId: "main",
            label: "Verification",
          },
          __openclaw: { id: "pending:agent-update" },
        };
        const blockedReason =
          "Agent updates not retried after restart: current session permissions do not allow automatic delivery.";
        const history = {
          messages: [
            { role: "user", content: "Please apply the mobile layout changes.", timestamp: 100 },
            {
              role: "assistant",
              content: "The mobile layout changes are ready. Waiting for the verification update.",
              timestamp: 200,
            },
            {
              role: "custom",
              customType: "session-send-recovery-blocked",
              content: blockedReason,
              display: true,
              excludeFromContext: true,
              timestamp: 500,
            },
          ],
          sessionId,
          sessionInfo: session,
          pendingInputs: {
            items: [
              {
                id: "agent-update",
                runId: "verification-update",
                acceptedAt: 1_000,
                state: "interrupted",
                message: update,
              },
            ],
            total: 1,
          },
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
        await page
          .getByText("The mobile layout changes are ready. Waiting for the verification update.", {
            exact: true,
          })
          .waitFor();
        await page.getByText(blockedReason, { exact: true }).waitFor();
        await captureUiProof(suite, page, "agent-update-recovery", "retained-update.png");
        await page
          .getByText("Delivery interrupted. This saved agent update is not scheduled to retry.", {
            exact: true,
          })
          .waitFor();
        expect(await page.getByText(/copy it and send again/u).count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await page.reload();
        await page
          .getByText("Delivery interrupted. This saved agent update is not scheduled to retry.", {
            exact: true,
          })
          .waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });

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
