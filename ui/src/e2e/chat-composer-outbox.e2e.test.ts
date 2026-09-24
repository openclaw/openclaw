import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI composer outbox" });

suite.define(() => {
  it("shows the queued message once instead of pre-queue guidance", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const sessionId = "session:" + sessionKey;
      const prompt = "Please also review the installation notes.";
      const gateway = await installMockGateway(page, { sessionKey });
      await page.goto(suite.server.baseUrl + "chat");
      await gateway.waitForRequest("chat.startup");
      await gateway.setOnline(false);
      await page.locator(".agent-chat__input--offline").waitFor();
      await page.locator(".gateway-status__label").filter({ hasText: "Reconnecting…" }).waitFor();

      const statusBand = page.locator(".agent-chat__composer-status-band");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      expect(await statusBand.count()).toBe(0);
      await composer.fill(prompt);
      expect(await statusBand.count()).toBe(0);
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const queue = page.locator(".chat-queue__item");
      await queue.getByText(prompt, { exact: true }).waitFor();
      expect(await queue.count()).toBe(1);
      await queue.getByText("Waiting for reconnect", { exact: true }).waitFor();
      expect(
        await page.locator(".chat-group.user").getByText(prompt, { exact: true }).count(),
      ).toBe(0);
      expect(await composer.inputValue()).toBe("");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await statusBand.textContent()).toContain("1 in this conversation’s outbox.");

      await gateway.deferNext("chat.send");
      await gateway.setOnline(true);
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({ sessionKey, message: prompt });
      const runId = requireString(requireRecord(request.params).idempotencyKey, "queued send id");
      const pendingMessage = {
        role: "user",
        content: prompt,
        timestamp: Date.now(),
        __openclaw: { id: "pending:composer-queued-input" },
      };
      const pending = {
        id: "composer-queued-input",
        runId,
        state: "queued",
        acceptedAt: pendingMessage.timestamp,
        message: pendingMessage,
      };
      const history = {
        sessionId,
        messages: [],
        sessionInfo: { key: sessionKey, sessionId, hasActiveRun: false, status: "done" },
      };
      await gateway.setMethodResponse("chat.history", {
        ...history,
        pendingInputs: { items: [pending], total: 1 },
        inputReceipts: [{ runId, state: "pending" }],
      });
      await gateway.resolveDeferred("chat.send", { runId, status: "queued" });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        agentId: "main",
        reason: "send",
      });
      // Accepted custody has no persisted entry ID until the input is consumed.
      await page.waitForFunction(
        ({ runId: expectedRunId, sessionId: expectedSessionId }) =>
          document
            .querySelector<
              HTMLElement & {
                state?: { chatQueue: Array<{ sendRunId?: string; sessionId?: string }> };
              }
            >("openclaw-chat-pane")
            ?.state?.chatQueue.some(
              (item) => item.sendRunId === expectedRunId && item.sessionId === expectedSessionId,
            ),
        { runId, sessionId },
      );
      await page.locator(".chat-group.user").getByText(prompt, { exact: true }).waitFor();
      expect(await page.getByText(prompt, { exact: true }).count()).toBe(1);
      expect(await queue.count()).toBe(0);
      expect(await statusBand.count()).toBe(0);

      const promoted = {
        ...pendingMessage,
        __openclaw: { id: "composer-queued-input", seq: 1, idempotencyKey: runId + ":user" },
      };
      await gateway.setMethodResponse("chat.history", {
        ...history,
        messages: [promoted],
        pendingInputs: { items: [], total: 0 },
        inputReceipts: [{ runId, state: "consumed", consumedByEventId: "composer-queued-input" }],
      });
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        message: promoted,
        messageId: "composer-queued-input",
        messageSeq: 1,
        clientRunId: runId,
      });
      await page
        .locator('.chat-bubble[data-entry-id="composer-queued-input"]')
        .getByText(prompt, { exact: true })
        .waitFor();
      expect(await page.getByText(prompt, { exact: true }).count()).toBe(1);
      expect(await queue.count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
    });
  });
});
