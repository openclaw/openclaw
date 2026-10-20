import { expect, it } from "vitest";
import {
  exactButton,
  newChatPage,
  chatSessionListResponse,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("reviews provider findings before explicit continuation and waits for the authoritative row", async () => {
    const page = await newChatPage(suite);
    const row = {
      key: "agent:main:main",
      agentId: "main",
      kind: "direct",
      sessionId: "synthetic-provider-review",
      updatedAt: Date.now(),
      snapshotAt: Date.now(),
    };
    const errorMessage =
      "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([row]),
      },
      deferredMethods: ["sessions.providerReview.continue"],
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.fill("Clean up the selected project.");
    await exactButton(page, "Send message").click();
    const sent = await gateway.waitForRequest("chat.send");
    const stoppedRunId = requireString(requireRecord(sent.params).idempotencyKey, "failed run ID");
    await gateway.emitGatewayEvent("chat", {
      runId: stoppedRunId,
      sessionKey: row.key,
      state: "error",
      errorMessage,
    });
    const failure = page.locator(".chat-error").filter({ hasText: errorMessage });
    await failure
      .locator("summary strong")
      .getByText("Couldn't finish this reply. Check the conversation before trying again.")
      .waitFor();
    await failure.locator("summary").click();
    const details = failure.getByLabel("Error details", { exact: true });
    await details.waitFor();
    expect(await details.textContent()).toContain(errorMessage);

    const providerReview = {
      id: "synthetic-review-one",
      runId: stoppedRunId,
      canContinue: true,
      explanation: "Cleanup reached outside the selected project.",
      continuationMessage: "Continue only inside the selected project.",
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
    await exactButton(page, "Review findings").waitFor();
    expect(await gateway.getRequests("sessions.providerReview.continue")).toHaveLength(0);
    expect(await composer.isDisabled()).toBe(true);
    await exactButton(page, "Review findings").click();
    const dialog = page.locator(".chat-provider-review-dialog");
    await dialog.getByText(providerReview.explanation, { exact: true }).waitFor();
    expect(await dialog.locator("blockquote").textContent()).toBe(
      providerReview.continuationMessage,
    );
    expect(await gateway.getRequests("sessions.providerReview.continue")).toHaveLength(0);
    await exactButton(dialog, "Acknowledge findings and continue").click();
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
    expect(await exactButton(page, "Send message").isEnabled()).toBe(true);
    expect(await gateway.getRequests("sessions.providerReview.continue")).toHaveLength(1);
  });
});
