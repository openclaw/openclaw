import { expect, it } from "vitest";
import {
  captureUiProof,
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("reviews provider findings before explicit continuation and waits for the authoritative row", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    try {
      const page = await context.newPage();
      const row = {
        key: "agent:main:main",
        agentId: "main",
        kind: "direct",
        sessionId: "synthetic-provider-review",
        label: "Project cleanup",
        updatedAt: Date.now(),
        snapshotAt: Date.now(),
      };
      const historyMessages = [
        {
          role: "assistant",
          content: [
            { type: "text", text: "I will inspect the selected project before making changes." },
          ],
        },
      ];
      const gateway = await installMockGateway(page, {
        historyMessages,
        methodResponses: {
          "sessions.list": chatSessionListResponse([row]),
        },
        deferredMethods: ["sessions.providerReview.continue"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Clean up the selected project.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const sent = await gateway.waitForRequest("chat.send");
      const stoppedRunId = requireString(
        requireRecord(sent.params).idempotencyKey,
        "failed run ID",
      );
      await gateway.emitGatewayEvent("chat", {
        runId: stoppedRunId,
        sessionKey: row.key,
        state: "error",
        errorMessage:
          "This request was blocked by our safety systems. Reason: Potentially unintended activity.",
      });
      await page
        .getByText(
          "This request was blocked by our safety systems. Reason: Potentially unintended activity.",
          { exact: false },
        )
        .first()
        .waitFor();
      await captureUiProof(suite, page, "provider-review", "before-generic-error.png");

      const providerReview = {
        id: "synthetic-review-one",
        runId: stoppedRunId,
        canContinue: true,
        explanation:
          "The proposed cleanup included files outside the project you selected. Those files may contain unrelated work. Confirm that the agent should limit changes to the selected project and preserve other files.",
        continuationMessage:
          "Continue only inside the selected project. Preserve all other files and review each proposed deletion first.",
      };
      const pausedAt = Date.now();
      const paused = {
        ...row,
        updatedAt: pausedAt,
        snapshotAt: pausedAt,
        hasActiveRun: false,
        activeRunIds: [],
        status: "failed",
        lastRunId: stoppedRunId,
        providerReview,
      };
      await gateway.setSessionsListResponse(chatSessionListResponse([paused]));
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: row.key,
        agentId: "main",
        session: paused,
      });
      await page.getByRole("button", { name: "Review findings", exact: true }).waitFor();
      expect(await gateway.getRequests("sessions.providerReview.continue")).toHaveLength(0);
      expect(await composer.isDisabled()).toBe(true);
      await captureUiProof(suite, page, "provider-review", "after-paused.png");
      await page.getByRole("button", { name: "Review findings", exact: true }).click();
      const dialog = page.locator(".chat-provider-review-dialog");
      await dialog.getByText(providerReview.explanation, { exact: true }).waitFor();
      expect(await dialog.locator("blockquote").textContent()).toBe(
        providerReview.continuationMessage,
      );
      expect(await gateway.getRequests("sessions.providerReview.continue")).toHaveLength(0);
      await captureUiProof(suite, page, "provider-review", "after-findings.png");
      await dialog
        .getByRole("button", { name: "Acknowledge findings and continue", exact: true })
        .click();
      const acknowledgment = await gateway.waitForRequest("sessions.providerReview.continue");
      expect(acknowledgment.params).toEqual({
        sessionKey: row.key,
        agentId: "main",
        sessionId: row.sessionId,
        reviewId: providerReview.id,
        idempotencyKey: expect.any(String),
      });
      await gateway.resolveDeferred("sessions.providerReview.continue", {
        runId: "accepted-continuation",
        status: "started",
      });
      await dialog
        .getByText("Continuation requested. Waiting for the provider to accept it.")
        .waitFor();
      expect(await composer.isDisabled()).toBe(true);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      const continuedAt = Math.max(Date.now(), pausedAt + 1);
      const continued = { ...row, updatedAt: continuedAt, snapshotAt: continuedAt };
      await gateway.setSessionsListResponse(chatSessionListResponse([continued]));
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: row.key,
        agentId: "main",
        session: { ...continued, providerReview: null },
      });
      await page.locator(".chat-provider-review").waitFor({ state: "detached" });
      await dialog.waitFor({ state: "detached" });
      await composer.fill("Review the remaining project files.");
      expect(
        await page.getByRole("button", { name: "Send message", exact: true }).isEnabled(),
      ).toBe(true);
      expect(await gateway.getRequests("sessions.providerReview.continue")).toHaveLength(1);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
