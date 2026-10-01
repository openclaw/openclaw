import { expect, it } from "vitest";
import { installMockGateway, reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI composer outbox" });

suite.define(() => {
  it("shows unsupported Steer errors and preserves recalled drafts through custody reconciliation", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const sessionId = "session:" + sessionKey;
      const row = {
        key: sessionKey,
        sessionId,
        hasActiveRun: true,
        activeRunIds: ["active-run"],
        status: "running",
        updatedAt: 100,
      };
      const pending = {
        id: "fault-input",
        runId: "fault-run",
        state: "queued",
        queued: true,
        acceptedAt: 101,
        message: { role: "user", content: "Queued synthetic input" },
      };
      const history = {
        sessionId,
        sessionInfo: row,
        messages: [
          {
            role: "user",
            content: "Previous synthetic prompt",
            timestamp: 100,
            __openclaw: { id: "previous", seq: 1 },
          },
        ],
        inFlightRun: { runId: "active-run", text: "Working on the synthetic task." },
        pendingInputs: { items: [pending], total: 1, queuedCount: 1 },
        inputReceipts: [{ runId: pending.runId, state: "pending", queued: true }],
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [row],
        sessionInfo: row,
        inFlightRun: history.inFlightRun,
        methodResponses: { "chat.startup": history, "chat.history": history },
      });
      await page.goto(suite.server.baseUrl + "chat");
      const queue = page.locator('[data-chat-queue-item="pending-input:fault-input"]');
      const steer = queue.getByRole("button", { name: "Steer queued message", exact: true });
      await steer.waitFor();
      await gateway.deferNext("chat.steer");
      await steer.click();
      await gateway.waitForRequest("chat.steer");
      await expect.poll(() => steer.getAttribute("aria-busy")).toBe("true");
      await gateway.rejectDeferred("chat.steer", {
        code: "INVALID_REQUEST",
        message: "unknown method: chat.steer",
      });
      await page.getByText("unknown method: chat.steer", { exact: true }).waitFor();
      await expect.poll(() => steer.isEnabled()).toBe(true);
      expect(await steer.getAttribute("aria-busy")).toBeNull();
      expect(await queue.count()).toBe(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Keep the unfinished synthetic draft");
      await composer.press("Home");
      await composer.press("ArrowUp");
      expect(await composer.inputValue()).toBe("Previous synthetic prompt");
      await gateway.setMethodResponse("chat.steer", {
        status: "queued",
        reason: "Stale refusal: it remains queued",
      });
      await gateway.setMethodResponse("chat.history", {
        ...history,
        pendingInputs: { items: [], total: 0, queuedCount: 0 },
        inputReceipts: [{ runId: pending.runId, state: "consumed" }],
      });
      await steer.click();
      await queue.waitFor({ state: "detached" });
      await expect.poll(() => composer.isEnabled()).toBe(true);
      await composer.press("ArrowDown");
      expect(await composer.inputValue()).toBe("Keep the unfinished synthetic draft");
      expect(
        await page.getByText("Stale refusal: it remains queued", { exact: true }).count(),
      ).toBe(0);
      expect(await page.getByText("unknown method: chat.steer", { exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("chat.steer")).toHaveLength(2);
    });
  });

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
      const cancelText = "Review these upgrade notes after the current task.";
      const cancelInput = {
        ...pending,
        id: "other-client-input",
        runId: cancelRunId,
        message: {
          role: "user",
          content: [
            { type: "text", text: cancelText },
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
      await queue.getByText(cancelText, { exact: true }).waitFor();
      expect(await queue.count()).toBe(2);
      await page.getByRole("button", { name: "Show earlier messages", exact: true }).click();
      await page.locator(".chat-group.user").getByText(olderText, { exact: true }).waitFor();
      expect(await queue.count()).toBe(2);
      expect(await queue.getByText(prompt, { exact: true }).count()).toBe(1);
      expect(await queue.getByText(cancelText, { exact: true }).count()).toBe(1);
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
      await gateway.setMethodResponse("chat.history", historyResponses(cancelledHistory));
      await gateway.resolveDeferred("chat.abort", { aborted: true, runIds: [cancelRunId] });
      await queue.waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Show latest messages", exact: true }).click();
      await page
        .getByRole("button", { name: "Show latest messages", exact: true })
        .waitFor({ state: "detached" });
      const expectRemoved = async () => {
        await page
          .locator('.chat-bubble[data-entry-id="composer-queued-input"]')
          .getByText(prompt, { exact: true })
          .waitFor();
        expect(await queue.count()).toBe(0);
        expect(await page.getByText(cancelText, { exact: true }).count()).toBe(0);
        expect(await page.getByText(cancelPrompt, { exact: true }).count()).toBe(0);
        expect(
          await page
            .getByText(
              "Cancelled before the agent started it. It will not run automatically; copy it and send again.",
              { exact: true },
            )
            .count(),
        ).toBe(0);
      };
      await expectRemoved();
      await page.screenshot({ path: suite.artifactDir + "/removed-message.png" });
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      await gateway.setMethodResponse("chat.startup", cancelledHistory);
      await reconnectMockGateway(page, gateway);
      await expectRemoved();
      expect(await gateway.getRequests("chat.send")).toHaveLength(1);

      await page.reload();
      await gateway.waitForRequest("chat.startup");
      await expectRemoved();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await page.screenshot({ path: suite.artifactDir + "/removed-message-after-reload.png" });

      const stopRunId = "ordinary-stopped-input";
      const stopText = "Keep this stopped request available to send again.";
      const stoppedInput = {
        ...pending,
        id: "stopped-input",
        runId: stopRunId,
        queued: undefined,
        message: { role: "user", content: stopText },
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
      await gateway.setMethodResponse("chat.history", historyResponses(activeHistory));
      await gateway.setMethodResponse("chat.startup", activeHistory);
      await reconnectMockGateway(page, gateway);
      const stop = page.getByRole("button", { name: "Stop generating", exact: true });
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
      await gateway.setMethodResponse("chat.history", historyResponses(stoppedHistory));
      await gateway.setMethodResponse("chat.startup", stoppedHistory);
      await gateway.setMethodResponse("chat.abort", { aborted: true, runIds: [stopRunId] });
      await stop.click();
      const stopped = await gateway.waitForRequest("chat.abort");
      expect(stopped.params).toEqual({ sessionKey, runId: stopRunId });
      await stop.waitFor({ state: "detached" });
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        agentId: "main",
        reason: "agent.input.settled",
      });
      await page.getByText(stopText, { exact: true }).waitFor();
      await page
        .getByText(
          "Cancelled before the agent started it. It will not run automatically; copy it and send again.",
          { exact: true },
        )
        .waitFor();
      expect(await page.getByText(cancelText, { exact: true }).count()).toBe(0);
      expect(await page.getByText(cancelPrompt, { exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await page.screenshot({ path: suite.artifactDir + "/stopped-message-retained.png" });
    });
  });
  it.each([
    { width: 1280, height: 900, theme: "dark" },
    { width: 768, height: 900, theme: "light" },
  ] as const)(
    "steers server-queued input without resending it at $width px in $theme mode",
    async ({ width, height, theme }) => {
      await suite.withPage(
        { viewport: { width, height }, colorScheme: theme },
        async ({ page }) => {
          const sessionKey = "agent:main:main";
          const sessionId = "session:" + sessionKey;
          const activeRunId = "already-running";
          const prompt = "Use a more compact layout for the grouped task list.";
          const row = {
            key: sessionKey,
            sessionId,
            label: "Queued message steering",
            hasActiveRun: true,
            activeRunIds: [activeRunId],
            effectiveQueueMode: "steer",
            status: "running",
            updatedAt: 100,
          };
          const pending = {
            id: "steer-source",
            runId: "steer-source-run",
            state: "queued",
            queued: true,
            acceptedAt: 101,
            message: { role: "user", content: prompt },
          };
          const attachment = {
            ...pending,
            id: "attachment-source",
            runId: "attachment-source-run",
            acceptedAt: 102,
            message: {
              role: "user",
              content: [
                {
                  type: "attachment",
                  attachment: {
                    kind: "document",
                    label: "layout-notes.pdf",
                    url: "/media/layout-notes.pdf",
                  },
                },
              ],
            },
          };
          const history = {
            sessionId,
            sessionInfo: row,
            messages: [
              {
                role: "assistant",
                content: "Reviewing the current task layout.",
                __openclaw: { id: "previous", seq: 1 },
              },
            ],
            inFlightRun: { runId: activeRunId, text: "Working through the layout changes." },
            pendingInputs: { items: [pending, attachment], total: 2, queuedCount: 2 },
            inputReceipts: [pending, attachment].map((input) => ({
              runId: input.runId,
              state: "pending",
              queued: true,
            })),
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessions: [row],
            sessionInfo: row,
            inFlightRun: history.inFlightRun,
            methodResponses: { "chat.startup": history, "chat.history": history },
          });
          await page.goto(suite.server.baseUrl + "chat");
          await gateway.waitForRequest("chat.startup");
          await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor();
          await page.evaluate((mode) => {
            document.documentElement.dataset.themeMode = mode;
          }, theme);
          const queue = page.locator('[data-chat-queue-item="pending-input:steer-source"]');
          const steer = queue.getByRole("button", { name: "Steer queued message", exact: true });
          await steer.waitFor();
          expect(await steer.isEnabled()).toBe(true);
          const attached = page.locator('[data-chat-queue-item="pending-input:attachment-source"]');
          await attached.getByText("layout-notes.pdf", { exact: true }).waitFor();
          expect(
            await attached.getByRole("button", { name: "Steer queued message" }).isEnabled(),
          ).toBe(true);
          await page.screenshot({ path: suite.artifactDir + "/server-steer-" + theme + ".png" });
          await reconnectMockGateway(page, gateway);
          await steer.waitFor();
          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.fill("Keep this unfinished draft");
          await gateway.deferNext("chat.steer");
          await steer.click();
          const control = await gateway.waitForRequest("chat.steer");
          expect(control.params).toEqual({
            sessionKey,
            agentId: "main",
            sessionId,
            runId: pending.runId,
          });
          await expect.poll(() => steer.isDisabled()).toBe(true);
          expect(await steer.getAttribute("aria-busy")).toBe("true");
          expect(await queue.count()).toBe(1);
          expect(await composer.inputValue()).toBe("Keep this unfinished draft");
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          await gateway.resolveDeferred("chat.steer", {
            status: "queued",
            reason: "The active run cannot accept this input. It remains queued.",
          });
          await expect.poll(() => steer.isEnabled()).toBe(true);
          await page
            .getByText("The active run cannot accept this input. It remains queued.", {
              exact: true,
            })
            .waitFor();
          expect(await queue.count()).toBe(1);
          const acceptedHistory = {
            ...history,
            pendingInputs: { items: [attachment], total: 1, queuedCount: 1 },
            inputReceipts: [
              { runId: pending.runId, state: "consumed" },
              { runId: attachment.runId, state: "pending", queued: true },
            ],
          };
          await gateway.setMethodResponse("chat.history", acceptedHistory);
          await gateway.setMethodResponse("chat.startup", acceptedHistory);
          await gateway.setMethodResponse("chat.steer", {
            status: "accepted",
            targetRunId: activeRunId,
          });
          await steer.click();
          await queue.waitFor({ state: "detached" });
          expect(await composer.inputValue()).toBe("Keep this unfinished draft");
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          await reconnectMockGateway(page, gateway);
          await attached.waitFor();
          await gateway.setMethodResponse("chat.steer", { status: "not_queued" });
          await gateway.setMethodResponse("chat.history", {
            ...acceptedHistory,
            pendingInputs: { items: [], total: 0, queuedCount: 0 },
            inputReceipts: [],
          });
          await attached.getByRole("button", { name: "Steer queued message", exact: true }).click();
          await attached.waitFor({ state: "detached" });
          const controls = await gateway.getRequests("chat.steer");
          expect(controls).toHaveLength(3);
          expect(controls[2]?.params).toEqual({
            sessionKey,
            agentId: "main",
            sessionId,
            runId: attachment.runId,
          });
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    },
  );
});
