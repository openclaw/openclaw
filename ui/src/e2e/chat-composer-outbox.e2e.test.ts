import { expect, it } from "vitest";
import { installMockGateway, reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI composer outbox" });

suite.define(() => {
  it("keeps server-queued inputs in the composer through reconnect until consumption or cancellation", async () => {
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
        queued: true,
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
        pendingInputs: { items: [pending], total: 1, queuedCount: 1 },
        inputReceipts: [{ runId, state: "pending", queued: true }],
      });
      await gateway.resolveDeferred("chat.send", { runId, status: "queued" });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        agentId: "main",
        reason: "agent.input.settled",
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
      await queue.getByText(prompt, { exact: true }).waitFor();
      expect(await page.getByText(prompt, { exact: true }).count()).toBe(1);
      expect(await queue.count()).toBe(1);
      expect(
        await page.locator(".chat-group.user").getByText(prompt, { exact: true }).count(),
      ).toBe(0);
      expect(
        await queue.locator(".chat-queue__steer, .chat-queue__retry, .chat-queue__grip").count(),
      ).toBe(0);
      expect(await statusBand.count()).toBe(0);
      await page.screenshot({ path: suite.artifactDir + "/queued-message.png" });

      await reconnectMockGateway(page, gateway);
      await queue.getByText(prompt, { exact: true }).waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      const cancelRunId = "server-queued-other-client";
      const cancelPrompt = "upgrade-notes.pdf";
      const cancelInput = {
        ...pending,
        id: "other-client-input",
        runId: cancelRunId,
        message: {
          role: "user",
          content: [
            {
              type: "attachment",
              attachment: {
                kind: "document",
                label: cancelPrompt,
                url: "/media/upgrade-notes.pdf",
              },
            },
          ],
        },
      };
      const olderText = "An earlier cancelled request.";
      const olderHistory = {
        ...history,
        pendingInputs: {
          items: [
            {
              ...pending,
              id: "earlier-input",
              runId: "earlier-run",
              queued: undefined,
              state: "cancelled",
              message: { role: "user", content: olderText },
            },
          ],
          total: 3,
        },
      };
      const historyResponses = <
        T extends {
          pendingInputs: { total: number; queuedCount: number };
          inputReceipts: unknown[];
        },
      >(
        latest: T,
      ) => ({
        cases: [
          {
            match: { pendingBefore: 21 },
            response: {
              ...olderHistory,
              pendingInputs: {
                ...olderHistory.pendingInputs,
                total: latest.pendingInputs.total,
                queuedCount: latest.pendingInputs.queuedCount,
              },
              // Exact custody receipts cover all requested inputs, independent of pagination.
              inputReceipts: latest.inputReceipts,
            },
          },
          { match: {}, response: latest },
        ],
      });
      await gateway.setMethodResponse(
        "chat.history",
        historyResponses({
          ...history,
          pendingInputs: {
            items: [pending, cancelInput],
            total: 3,
            nextBefore: 21,
            queuedCount: 2,
          },
          inputReceipts: [
            { runId, state: "pending", queued: true },
            { runId: cancelRunId, state: "pending", queued: true },
          ],
        }),
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        agentId: "main",
        reason: "agent.input.settled",
      });
      await page.locator('[data-chat-queue-item="pending-input:other-client-input"]').waitFor();
      await page.screenshot({ path: suite.artifactDir + "/queued-attachment.png" });
      await queue.getByText(cancelPrompt, { exact: true }).waitFor();
      expect(await queue.count()).toBe(2);
      await page.getByRole("button", { name: "Show earlier messages", exact: true }).click();
      await page.locator(".chat-group.user").getByText(olderText, { exact: true }).waitFor();
      expect(await queue.count()).toBe(2);
      expect(await queue.getByText(prompt, { exact: true }).count()).toBe(1);
      expect(await queue.getByText(cancelPrompt, { exact: true }).count()).toBe(1);
      expect(
        await page.locator(".chat-group.user").getByText(prompt, { exact: true }).count(),
      ).toBe(0);
      await page.screenshot({ path: suite.artifactDir + "/queued-attachment-history.png" });

      const promoted = {
        ...pendingMessage,
        __openclaw: { id: "composer-queued-input", seq: 1, idempotencyKey: runId + ":user" },
      };
      await gateway.setMethodResponse(
        "chat.history",
        historyResponses({
          ...history,
          messages: [promoted],
          pendingInputs: { items: [cancelInput], total: 2, nextBefore: 21, queuedCount: 1 },
          // Ordinary consumption deletes the pending row rather than retaining a receipt.
          inputReceipts: [{ runId: cancelRunId, state: "pending", queued: true }],
        }),
      );
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
      expect(await queue.count()).toBe(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      const recentReply = "The earlier installation review is complete. Continuing recent work.";
      const recentHistory = {
        ...history,
        messages: [
          {
            role: "assistant",
            content: recentReply,
            __openclaw: { id: "recent-response", seq: 100 },
          },
        ],
        totalMessages: 100,
        hasMore: true,
        nextOffset: 1,
        pendingInputs: { items: [cancelInput], total: 2, nextBefore: 21, queuedCount: 1 },
        inputReceipts: [{ runId: cancelRunId, state: "pending", queued: true }],
      };
      await gateway.setMethodResponse("chat.history", historyResponses(recentHistory));
      // Case-based history responses are not copied into the mock's startup method.
      await gateway.setMethodResponse("chat.startup", recentHistory);
      await reconnectMockGateway(page, gateway);
      await page.locator(".chat-group.assistant").getByText(recentReply, { exact: true }).waitFor();
      await page.screenshot({ path: suite.artifactDir + "/queue-after-consumption-reconnect.png" });
      expect(await queue.getByText(prompt, { exact: true }).count()).toBe(0);
      expect(await queue.count()).toBe(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      await gateway.deferNext("chat.abort");
      await queue
        .filter({ hasText: cancelPrompt })
        .getByRole("button", { name: "Remove queued message" })
        .click();
      const cancellation = await gateway.waitForRequest("chat.abort");
      expect(cancellation.params).toMatchObject({ sessionKey, runId: cancelRunId });
      expect(await queue.count()).toBe(1);
      await gateway.setMethodResponse(
        "chat.history",
        historyResponses({
          ...history,
          messages: [promoted],
          pendingInputs: {
            items: [{ ...cancelInput, queued: undefined, state: "cancelled" }],
            total: 2,
            nextBefore: 21,
            queuedCount: 0,
          },
          inputReceipts: [{ runId: cancelRunId, state: "pending" }],
        }),
      );
      await gateway.resolveDeferred("chat.abort", { aborted: true, runIds: [cancelRunId] });
      await queue.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Show latest messages", exact: true }).click();
      await page.locator(".chat-group.user").getByText(cancelPrompt, { exact: true }).waitFor();
      expect(await queue.count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);
    });
  });
});
