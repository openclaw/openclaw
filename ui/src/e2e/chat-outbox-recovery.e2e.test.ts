import { expect as expectBrowser, type Page } from "playwright/test";
import { expect, it } from "vitest";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { createControlUiMockSameOriginGatewayScript } from "../test-helpers/control-ui-e2e.ts";
import {
  chatMessage,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { outboxButton as button } from "./chat-outbox-payloads.test-support.ts";

const suite = createChatFlowE2eSuite();
const pageOptions = { locale: "en-US", serviceWorkers: "block" as const };
const viewport = { width: 1280, height: 900 };
const composerFor = (page: Page) => page.locator(".agent-chat__composer-combobox textarea");
const userFor = (page: Page, text: string, exact = false) =>
  page.locator(".chat-group.user").getByText(text, { exact });
async function publishHistory(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  content: string,
  runId: string,
  id: string,
  seq: number,
  active = false,
) {
  const timestamp = Date.now();
  await gateway.setHistoryMessages([
    {
      content,
      role: "user",
      timestamp,
      idempotencyKey: `${runId}:user`,
      __openclaw: { id, seq, idempotencyKey: `${runId}:user` },
    },
  ]);
  await gateway.emitGatewayEvent("session.message", {
    ...(active ? { clientRunId: runId } : {}),
    hasActiveRun: active,
    messageId: id,
    messageSeq: seq,
    sessionKey: "main",
    status: active ? "running" : "done",
  });
  return timestamp;
}

suite.define(() => {
  it(
    "keeps delivery recovery visible and keyboard-reachable in narrow chat",
    () =>
      suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 320, height: 844 } },
        async ({ page }) => {
          await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
          await installMockGateway(page, {
            historyMessages: ["failed", "unconfirmed", "waiting-reconnect", "held"].flatMap(
              (state, index) => [
                chatMessage("user", "Pending " + state, {
                  timestamp: 1_000 + index * 2,
                  __openclaw: {
                    id: "delivery-" + index,
                    kind: "pending-send",
                    state,
                    ...(index === 1
                      ? {
                          senderId: "peer",
                          senderName: "Peer",
                          senderIdentity: { type: "profile", id: "peer" },
                        }
                      : {}),
                  },
                }),
                chatMessage("assistant", "Separate turn", {
                  timestamp: 1_001 + index * 2,
                }),
              ],
            ),
          });
          await page.goto(suite.server.baseUrl + "chat");
          const statuses = page.locator(".chat-send-status");
          await expectBrowser(statuses).toHaveCount(4, { timeout: 30_000 });
          const held = page.locator('.chat-send-status[data-send-state="held"]');
          await expectBrowser(held).toContainText("Delivery uncertain");
          await expectBrowser(button(held, "Discard")).toBeVisible();
          // Enlarged text must not push recovery controls outside the conversation.
          await page.addStyleTag({ content: ".chat-send-status { font-size: 24px; }" });
          for (const theme of ["light", "dark"]) {
            await page.evaluate((mode) => {
              document.documentElement.dataset.themeMode = mode;
            }, theme);
            for (const status of await statuses.all()) {
              await status.scrollIntoViewIfNeeded();
              await page.mouse.move(0, 0);
              const footer = status.locator(
                "xpath=ancestor::div[contains(@class, 'chat-group-footer--send-status')]",
              );
              await expectBrowser(footer).toHaveCSS("opacity", "1");
              for (const action of await status.getByRole("button").all()) {
                await expectBrowser(action).toBeVisible();
                await expectBrowser(action).toBeEnabled();
                const bounds = await action.boundingBox();
                if (!bounds) {
                  throw new Error("Recovery action has no rendered bounds");
                }
                expect(bounds.x).toBeGreaterThanOrEqual(0);
                expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
              }
            }
            const unconfirmed = page.locator('.chat-send-status[data-send-state="unconfirmed"]');
            const retry = unconfirmed.getByRole("button", { name: "Retry queued message" });
            await retry.focus();
            await page.keyboard.press("Tab");
            await expectBrowser(button(unconfirmed, "Discard")).toBeFocused();
            await page.keyboard.press("Shift+Tab");
            await expectBrowser(retry).toBeFocused();
            await retry.evaluate((element) => (element as HTMLElement).blur());
          }
        },
      ),
    60_000,
  );

  it.each(["retry", "discard", "exact authoritative history proof"] as const)(
    "parks an ACK-lost send for review until %s",
    (action) =>
      suite.withPage({ ...pageOptions, viewport }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "chat.history": {
              messages: [],
              sessionId: "session:agent:main:main",
              sessionInfo: { hasActiveRun: false, status: "done" },
              thinkingLevel: null,
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.deferNext("chat.send");

        const prompt =
          action === "exact authoritative history proof"
            ? "already accepted after the reconnect"
            : "retry with the same key";
        await composerFor(page).fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();

        const firstRequest = await gateway.waitForRequest("chat.send");
        const firstParams = requireRecord(firstRequest.params);
        const runId = requireString(firstParams.idempotencyKey, "first idempotency key");

        await gateway.setOnline(false);
        const userBubble = userFor(page, prompt, true);
        const reconnectStatus = page.locator(
          '.chat-send-status[data-send-state="waiting-reconnect"]',
        );
        await userBubble.waitFor();
        expect(await page.locator(".chat-queue__item").count()).toBe(0);
        await reconnectStatus.getByText("Waiting for reconnect", { exact: true }).waitFor();
        expect(await userBubble.count()).toBe(1);
        expect(await reconnectStatus.getByRole("button", { name: /Retry/ }).count()).toBe(0);
        await button(reconnectStatus, "Discard").waitFor();
        await gateway.setOnline(true);

        const deliveryStatus = page.locator('.chat-send-status[data-send-state="unconfirmed"]');
        await deliveryStatus.getByText("Delivery unconfirmed").waitFor({ timeout: 10_000 });
        expect(await page.locator(".chat-queue").count()).toBe(0);
        await userBubble.waitFor();
        expect(await gateway.getRequests("chat.send")).toHaveLength(1);

        if (action === "exact authoritative history proof") {
          const historyReads = (await gateway.getRequests("chat.history")).length;
          await expectRequestCountStable(gateway, "chat.history", historyReads);
          for (const event of ["session.message", "sessions.changed"]) {
            await gateway.emitGatewayEvent(event, {
              sessionKey: "agent:main:unrelated-conversation",
              hasActiveRun: true,
              phase: "message",
            });
          }
          await expectRequestCountStable(gateway, "chat.history", historyReads);
          await deliveryStatus.getByText("Delivery unconfirmed").waitFor();

          const pane = page.locator("openclaw-chat-pane");
          const waitForHistoryCommit = async (timestamp: number) => {
            await page.waitForFunction((expectedTimestamp) => {
              const current = document.querySelector<
                HTMLElement & {
                  state?: { chatLoading: boolean; chatMessages: Array<{ timestamp?: number }> };
                }
              >("openclaw-chat-pane")?.state;
              return (
                current?.chatLoading === false &&
                current.chatMessages.some((message) => message.timestamp === expectedTimestamp)
              );
            }, timestamp);
            await pane.evaluate(
              (element) =>
                (element as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete,
            );
          };
          const differentTimestamp = await publishHistory(
            gateway,
            "different delivered turn",
            "different-run",
            "different-history-turn",
            1,
          );
          await waitForHistoryCommit(differentTimestamp);
          await deliveryStatus.getByText("Delivery unconfirmed").waitFor({ timeout: 10_000 });
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);

          const historyCount = async (match: Record<string, unknown>) =>
            (await gateway.getRequests("chat.history", match)).length;
          const receiptMatch = { sessionKey: "agent:main:main", limit: 1000 };
          const displayMatch = { sessionKey: "agent:main:main", limit: 80 };
          const receiptBefore = await historyCount(receiptMatch);
          const displayBefore = await historyCount(displayMatch);
          await gateway.deferNext("chat.history", receiptMatch);
          const acceptedTimestamp = await publishHistory(
            gateway,
            prompt,
            runId,
            "accepted-history-turn",
            2,
            true,
          );
          await gateway.waitForRequest("chat.history", {
            after: receiptBefore,
            match: receiptMatch,
          });
          await gateway.waitForRequest("chat.history", {
            after: displayBefore,
            match: displayMatch,
          });
          // This exact history row is committed while the recovery receipt is held.
          await waitForHistoryCommit(acceptedTimestamp);
          expect(await userBubble.count()).toBe(1);

          const refreshBefore = await historyCount(displayMatch);
          await gateway.deferNext("chat.history", displayMatch);
          // Only the receipt has been admitted to the FIFO of deferred responses.
          await gateway.resolveDeferred("chat.history");
          await deliveryStatus.waitFor({ state: "detached", timeout: 10_000 });
          // Native history can retire the outbox before the held receipt returns.
          // Otherwise, join admission of the refresh before checking its held window.
          await page.waitForFunction(
            ({ before, match }) => {
              const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway;
              return (
                document.querySelector(
                  '.chat-group.user .chat-bubble[data-entry-id="accepted-history-turn"]',
                ) !== null || (mock?.findRequests("chat.history", match).length ?? 0) > before
              );
            },
            { before: refreshBefore, match: displayMatch },
          );
          await pane.evaluate(
            (element) =>
              (element as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete,
          );
          expect(
            await userBubble.count(),
            "The committed user row must survive receipt retirement while readback is held",
          ).toBe(1);
          const durableBubble = page.locator(
            '.chat-group.user .chat-bubble[data-entry-id="accepted-history-turn"]',
          );
          expect(await durableBubble.count()).toBe(1);
          expect(await durableBubble.getByText(prompt, { exact: true }).count()).toBe(1);
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);

          if ((await historyCount(displayMatch)) > refreshBefore) {
            await gateway.resolveDeferred("chat.history");
            await waitForHistoryCommit(acceptedTimestamp);
          }
          expect(await durableBubble.count()).toBe(1);
          expect(await userBubble.count()).toBe(1);
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);
          return;
        }

        if (action === "discard") {
          await composerFor(page).fill("send the next message");
          await page.getByRole("button", { name: "Send message" }).click();
          await page
            .locator(".chat-queue")
            .getByText("send the next message", { exact: true })
            .waitFor();
          await expectRequestCountStable(gateway, "chat.send", 1);
          await button(deliveryStatus, "Discard").click();
        } else {
          await deliveryStatus.getByRole("button", { name: "Retry queued message" }).click();
        }

        const sends = await waitForRequests(gateway, "chat.send", 2);
        const secondParams = requireRecord(sends[1]?.params);
        expect(secondParams.sessionKey).toBe(firstParams.sessionKey);
        if (action === "discard") {
          expect(secondParams.idempotencyKey).not.toBe(runId);
          expect(secondParams.message).toBe("send the next message");
          await userBubble.waitFor({ state: "detached" });
          expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
          expect(await gateway.getRequests("sessions.abort")).toHaveLength(0);
        } else {
          expect(secondParams).toMatchObject({ idempotencyKey: runId, message: prompt });
        }
        await expectRequestCountStable(gateway, "chat.send", 2);
        await deliveryStatus.waitFor({ state: "detached", timeout: 10_000 });
      }),
  );
});
