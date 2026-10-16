import { expect, it } from "vitest";
import { waitForControlUiGatewayReconnecting } from "../test-helpers/control-ui-e2e-readiness.ts";
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
      const text = (value: string) => page.getByText(value, { exact: true });
      const userText = (value: string) =>
        page.locator(".chat-group.user").getByText(value, { exact: true });
      const snapshot = (name: string) =>
        page.screenshot({ path: `${suite.artifactDir}/${name}.png` });
      const button = (name: string) => page.getByRole("button", { name, exact: true });
      const user = <T>(content: T) => ({ role: "user", content });
      const receipt = (runId: string) => ({ runId, state: "pending", queued: true });
      const settled = () =>
        gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          agentId: "main",
          reason: "agent.input.settled",
        });
      await gateway.setOnline(false);
      await page.locator(".agent-chat__input--offline").waitFor();
      await waitForControlUiGatewayReconnecting(page);

      const statusBand = page.locator(".agent-chat__composer-status-band");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      expect(await statusBand.count()).toBe(0);
      await composer.fill(prompt);
      expect(await statusBand.count()).toBe(0);
      await button("Send message").click();
      const queue = page.locator(".chat-queue__item");
      const promotedBubble = page
        .locator('.chat-bubble[data-entry-id="composer-queued-input"]')
        .getByText(prompt, { exact: true });
      const cancellationNotice = text(
        "Cancelled before the agent started it. It will not run automatically; copy it and send again.",
      );
      await queue.getByText(prompt, { exact: true }).waitFor();
      expect(await queue.count()).toBe(1);
      await queue.getByText("Waiting for reconnect", { exact: true }).waitFor();
      expect(await userText(prompt).count()).toBe(0);
      expect(await composer.inputValue()).toBe("");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await statusBand.count()).toBe(0);

      await gateway.deferNext("chat.send");
      await gateway.setOnline(true);
      const request = await gateway.waitForRequest("chat.send");
      expect(request.params).toMatchObject({ sessionKey, message: prompt });
      const runId = requireString(requireRecord(request.params).idempotencyKey, "queued send id");
      const pendingMessage = {
        ...user(prompt),
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
        inputReceipts: [receipt(runId)],
      });
      await gateway.resolveDeferred("chat.send", { runId, status: "queued" });
      await settled();
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
      expect(await text(prompt).count()).toBe(1);
      expect(await queue.count()).toBe(1);
      expect(await userText(prompt).count()).toBe(0);
      expect(
        await queue.locator(".chat-queue__steer, .chat-queue__retry, .chat-queue__grip").count(),
      ).toBe(0);
      expect(await statusBand.count()).toBe(0);
      await snapshot("queued-message");

      await reconnectMockGateway(page, gateway);
      await queue.getByText(prompt, { exact: true }).waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      const cancelRunId = "server-queued-other-client";
      const cancelPrompt = "upgrade-notes.pdf";
      const cancelText = "Review these upgrade notes after the current task.";
      const cancelInput = {
        ...pending,
        id: "other-client-input",
        runId: cancelRunId,
        message: user([
          { type: "text", text: cancelText },
          {
            type: "attachment",
            attachment: {
              kind: "document",
              label: cancelPrompt,
              url: "/media/upgrade-notes.pdf",
            },
          },
        ]),
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
              message: user(olderText),
            },
          ],
          total: 3,
        },
      };
      const setHistory = <
        T extends {
          pendingInputs: { total: number; queuedCount: number };
          inputReceipts: unknown[];
        },
      >(
        latest: T,
      ) =>
        gateway.setMethodResponse("chat.history", {
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
      await setHistory({
        ...history,
        pendingInputs: {
          items: [pending, cancelInput],
          total: 3,
          nextBefore: 21,
          queuedCount: 2,
        },
        inputReceipts: [receipt(runId), receipt(cancelRunId)],
      });
      await settled();
      await page.locator('[data-chat-queue-item="pending-input:other-client-input"]').waitFor();
      await snapshot("queued-attachment");
      await queue.getByText(cancelText, { exact: true }).waitFor();
      expect(await queue.count()).toBe(2);
      await button("Show earlier messages").click();
      await userText(olderText).waitFor();
      expect(await queue.count()).toBe(2);
      expect(await queue.getByText(prompt, { exact: true }).count()).toBe(1);
      expect(await queue.getByText(cancelText, { exact: true }).count()).toBe(1);
      expect(await userText(prompt).count()).toBe(0);
      await snapshot("queued-attachment-history");

      const promoted = {
        ...pendingMessage,
        __openclaw: { id: "composer-queued-input", seq: 1, idempotencyKey: runId + ":user" },
      };
      await setHistory({
        ...history,
        messages: [promoted],
        pendingInputs: { items: [cancelInput], total: 2, nextBefore: 21, queuedCount: 1 },
        // Ordinary consumption deletes the pending row rather than retaining a receipt.
        inputReceipts: [receipt(cancelRunId)],
      });
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        message: promoted,
        messageId: "composer-queued-input",
        messageSeq: 1,
        clientRunId: runId,
      });
      await promotedBubble.waitFor();
      expect(await text(prompt).count()).toBe(1);
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
        inputReceipts: [receipt(cancelRunId)],
      };
      await setHistory(recentHistory);
      // Case-based history responses are not copied into the mock's startup method.
      await gateway.setMethodResponse("chat.startup", recentHistory);
      await reconnectMockGateway(page, gateway);
      await page.locator(".chat-group.assistant").getByText(recentReply, { exact: true }).waitFor();
      await snapshot("queue-after-consumption-reconnect");
      expect(await queue.getByText(prompt, { exact: true }).count()).toBe(0);
      expect(await queue.count()).toBe(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      await gateway.deferNext("chat.abort");
      await queue
        .filter({ hasText: cancelText })
        .getByRole("button", { name: "Remove queued message" })
        .click();
      const cancellation = await gateway.waitForRequest("chat.abort");
      expect(cancellation.params).toEqual({
        sessionKey,
        agentId: "main",
        runId: cancelRunId,
        discardPendingInput: true,
      });
      expect(await queue.count()).toBe(1);
      const cancelledHistory = {
        ...history,
        messages: [promoted],
        pendingInputs: {
          items: [
            {
              ...cancelInput,
              queued: undefined,
              state: "cancelled",
              message: { role: "user", content: [], display: false },
            },
          ],
          total: 2,
          nextBefore: 21,
          queuedCount: 0,
        },
        inputReceipts: [{ runId: cancelRunId, state: "pending", cancelled: true }],
      };
      await setHistory(cancelledHistory);
      await gateway.resolveDeferred("chat.abort", { aborted: true, runIds: [cancelRunId] });
      await queue.waitFor({ state: "detached" });
      await button("Show latest messages").click();
      await button("Show latest messages").waitFor({ state: "detached" });
      const expectRemoved = async () => {
        await promotedBubble.waitFor();
        expect(await queue.count()).toBe(0);
        expect(await text(cancelText).count()).toBe(0);
        expect(await text(cancelPrompt).count()).toBe(0);
        expect(await cancellationNotice.count()).toBe(0);
      };
      await expectRemoved();
      await snapshot("removed-message");
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      await gateway.setMethodResponse("chat.startup", cancelledHistory);
      await reconnectMockGateway(page, gateway);
      await expectRemoved();
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      await page.reload();
      await gateway.waitForRequest("chat.startup");
      await expectRemoved();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await snapshot("removed-message-after-reload");

      const stopRunId = "ordinary-stopped-input";
      const stopText = "Keep this stopped request available to send again.";
      const stoppedInput = {
        ...pending,
        id: "stopped-input",
        runId: stopRunId,
        queued: undefined,
        message: user(stopText),
      };
      const activeHistory = {
        ...cancelledHistory,
        sessionInfo: {
          ...history.sessionInfo,
          hasActiveRun: true,
          activeRunIds: [stopRunId],
          status: "running",
        },
        inFlightRun: { runId: stopRunId, text: "Preparing the retained request." },
        pendingInputs: {
          ...cancelledHistory.pendingInputs,
          items: [...cancelledHistory.pendingInputs.items, stoppedInput],
          total: 3,
        },
      };
      await setHistory(activeHistory);
      await gateway.setMethodResponse("chat.startup", activeHistory);
      await reconnectMockGateway(page, gateway);
      const stop = button("Stop generating");
      await stop.waitFor();

      const stoppedHistory = {
        ...activeHistory,
        sessionInfo: history.sessionInfo,
        inFlightRun: null,
        pendingInputs: {
          ...activeHistory.pendingInputs,
          items: [...cancelledHistory.pendingInputs.items, { ...stoppedInput, state: "cancelled" }],
        },
      };
      await setHistory(stoppedHistory);
      await gateway.setMethodResponse("chat.startup", stoppedHistory);
      await gateway.setMethodResponse("chat.abort", { aborted: true, runIds: [stopRunId] });
      await stop.click();
      const stopped = await gateway.waitForRequest("chat.abort");
      expect(stopped.params).toEqual({ sessionKey, runId: stopRunId });
      await stop.waitFor({ state: "detached" });
      await settled();
      await text(stopText).waitFor();
      await cancellationNotice.waitFor();
      expect(await text(cancelText).count()).toBe(0);
      expect(await text(cancelPrompt).count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await snapshot("stopped-message-retained");
    });
  });
});
