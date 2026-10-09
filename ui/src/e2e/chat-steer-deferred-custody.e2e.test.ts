import path from "node:path";
import { expect, it } from "vitest";
import { prepareChatHistoryFixture } from "../test-helpers/chat-activity-fixtures.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Deferred steering custody" });

suite.define(() => {
  it("moves a deferred steer into the queue on custody publication without another reply", async () => {
    await suite.withPage({ viewport: { width: 393, height: 852 } }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const runId = "active-run";
      const timestamp = Date.now();
      const messages = [
        {
          role: "user",
          content: "Investigate the shared chat state",
          timestamp,
          __openclaw: { id: "original", seq: 1, idempotencyKey: runId + ":user" },
        },
      ];
      const sessionInfo = {
        key: sessionKey,
        sessionId: "session:" + sessionKey,
        kind: "direct",
        hasActiveRun: true,
        activeRunIds: [runId],
        status: "running",
        startedAt: timestamp,
      };
      const history = {
        ...prepareChatHistoryFixture(messages),
        sessionId: sessionInfo.sessionId,
        sessionInfo,
        inFlightRun: { runId, text: "Checking the shared queue now.", startedAt: timestamp },
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages: messages,
        sessionInfo,
        inFlightRun: history.inFlightRun,
      });
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-follow-up-mode]").selectOption("queue");
      await page.locator("[data-settings-send-shortcut]").selectOption("enter");
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const composer = page.locator(".agent-chat__input textarea");
      await page.getByRole("button", { name: "Stop generating" }).waitFor();
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        state: "delta",
        message: { role: "assistant", content: "Checking the shared queue now." },
      });
      await page
        .locator(".chat-bubble")
        .getByText("Checking the shared queue now.", { exact: true })
        .waitFor();
      const correction = "This also happens outside Claude CLI";
      await composer.fill(correction);
      await gateway.deferNext("chat.send");
      await composer.press("Control+Enter");
      const queued = page.locator(".chat-queue__item", { hasText: correction });
      const sent = await gateway.waitForRequest("chat.send");
      expect(sent.params).toMatchObject({ queueMode: "steer" });
      const pendingRunId = (sent.params as { idempotencyKey: string }).idempotencyKey;
      await gateway.resolveDeferred("chat.send", { runId: pendingRunId, status: "started" });
      await expect
        .poll(() => page.locator(".chat-group.user", { hasText: correction }).count())
        .toBe(1);
      await page.screenshot({
        path: path.join(suite.artifactDir, "before-queue-confirmation.png"),
      });
      // Dispatch settlement exposes follow-up custody without another parent reply.
      await gateway.setMethodResponse("chat.history", {
        ...history,
        inputReceipts: [{ runId: pendingRunId, state: "pending", queued: true }],
        pendingInputs: {
          items: [
            {
              id: "deferred-correction",
              runId: pendingRunId,
              acceptedAt: Date.now(),
              state: "queued",
              queued: true,
              message: { role: "user", content: correction, timestamp: Date.now() },
            },
          ],
          total: 1,
          queuedCount: 1,
        },
      });
      const reads = (await gateway.getRequests("chat.history")).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        ...sessionInfo,
        sessionKey,
        reason: "agent.input.settled",
        updatedAt: Date.now(),
      });
      await gateway.waitForRequest("chat.history", { after: reads });
      await expect.poll(() => queued.count()).toBe(1);
      await expect
        .poll(() => page.locator(".chat-group.user", { hasText: correction }).count())
        .toBe(0);
      await expect
        .poll(() => page.getByRole("button", { name: "Stop generating" }).isVisible())
        .toBe(true);
      await page.screenshot({ path: path.join(suite.artifactDir, "after-queue-confirmation.png") });
    });
  });
});
