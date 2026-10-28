import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect as expectBrowser, type Page } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiMockSameOriginGatewayScript } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProofEnabled,
  chatMessage,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  scrollChatThreadToTop,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { outboxButton as button, readOutboxQueue } from "./chat-outbox-payloads.test-support.ts";

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
) {
  await gateway.setHistoryMessages([
    {
      content,
      role: "user",
      timestamp: Date.now(),
      idempotencyKey: `${runId}:user`,
      __openclaw: { id, seq, idempotencyKey: `${runId}:user` },
    },
  ]);
  await gateway.emitGatewayEvent("session.message", {
    hasActiveRun: false,
    messageId: id,
    messageSeq: seq,
    sessionKey: "main",
    status: "done",
  });
}

suite.define(() => {
  it(
    "keeps delivery recovery visible and keyboard-reachable in narrow chat",
    () =>
      suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 320, height: 844 } },
        async ({ page }) => {
          await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
          const gateway = await installMockGateway(page, {
            historyMessages: ["failed", "waiting-reconnect", "held"].flatMap((state, index) => [
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
            ]),
          });
          await page.goto(suite.server.baseUrl + "chat");
          await page.locator('.chat-send-status[data-send-state="held"]').waitFor();
          const held = page.locator('.chat-send-status[data-send-state="held"]');
          await expectBrowser(held).toContainText("Needs review");
          await expectBrowser(button(held, "Discard")).toBeVisible();
          // Enlarged text must not push recovery controls outside the conversation.
          await page.addStyleTag({ content: ".chat-send-status { font-size: 24px; }" });
          for (const theme of ["light", "dark"]) {
            await gateway.setOnline(false);
            await page.evaluate((mode) => {
              document.documentElement.dataset.themeMode = mode;
            }, theme);
            // Recovery rows can unmount outside the virtualized transcript window.
            await scrollChatThreadToTop(page);
            for (const state of ["failed", "waiting-reconnect", "held"]) {
              const status = page.locator(`.chat-send-status[data-send-state="${state}"]`);
              await expectBrowser(status).toBeVisible({ timeout: 30_000 });
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
            // Retry requires a live connection; reconnect after measuring offline recovery.
            await gateway.setOnline(true);
            await scrollChatThreadToTop(page);
            const failed = page.locator('.chat-send-status[data-send-state="failed"]');
            const retry = failed.getByRole("button", { name: "Retry queued message" });
            await retry.focus();
            await page.keyboard.press("Tab");
            await expectBrowser(button(failed, "Discard")).toBeFocused();
            await page.keyboard.press("Shift+Tab");
            await expectBrowser(retry).toBeFocused();
            await retry.evaluate((element) => (element as HTMLElement).blur());
          }
        },
      ),
    60_000,
  );

  it.each(["duplicate", "rejection", "discard"] as const)(
    "reconciles an ACK-lost send on reconnect (%s)",
    (outcome) =>
      suite.withPage({ ...pageOptions, viewport }, async ({ page }) => {
        const artifactDir = captureUiProofEnabled
          ? createControlUiE2eArtifactDir(`chat-send-reconcile-${outcome}`)
          : undefined;
        const gateway = await installMockGateway(page, {
          heldMethods: ["chat.send"],
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
        const prompt = "Reconcile this exact submission";
        await composerFor(page).fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();
        const first = await gateway.waitForRequest("chat.send");
        const firstParams = requireRecord(first.params);
        const runId = requireString(firstParams.idempotencyKey, "original idempotency key");
        await gateway.setOnline(false);
        const pending = page.locator('.chat-send-status[data-send-state="waiting-reconnect"]');
        await pending.getByText("Waiting for reconnect", { exact: true }).waitFor();
        await expectBrowser(userFor(page, prompt, true)).toHaveCount(1);
        expect(await page.locator(".chat-queue__item").count()).toBe(0);
        await expectBrowser(pending.getByRole("button", { name: /Retry/ })).toHaveCount(0);
        await button(pending, "Discard").waitFor();
        if (artifactDir) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("openclaw-chat-pane"),
            [
              userFor(page, prompt, true),
              pending.getByText("Waiting for reconnect", { exact: true }),
            ],
            { animations: "disabled" },
          );
          await writeFile(path.join(artifactDir, "after-waiting-for-reconnect.png"), frame.png);
        }

        if (outcome === "discard") {
          await composerFor(page).fill("The next queued message");
          await page.getByRole("button", { name: "Send message" }).click();
          await page
            .locator(".chat-queue")
            .getByText("The next queued message", { exact: true })
            .waitFor();
          await expectRequestCountStable(gateway, "chat.send", 1);
          await button(pending, "Discard").click();
          await userFor(page, prompt, true).waitFor({ state: "detached" });
        }
        await gateway.setOnline(true);
        const sends = await waitForRequests(gateway, "chat.send", 2);
        const nextParams = requireRecord(sends[1]?.params);
        expect(nextParams.sessionKey).toBe(firstParams.sessionKey);
        let requestCount = 2;
        let acceptedRunId = runId;
        if (outcome === "discard") {
          expect(nextParams.message).toBe("The next queued message");
          expect(nextParams.idempotencyKey).not.toBe(runId);
          acceptedRunId = requireString(nextParams.idempotencyKey, "next submission key");
          expect(await gateway.getRequests("chat.abort")).toHaveLength(0);
          expect(await gateway.getRequests("sessions.abort")).toHaveLength(0);
        } else {
          expect(nextParams).toEqual({ ...firstParams, __controlUiReconnectResume: true });
          expect(await page.locator(".chat-queue").count()).toBe(0);
          await expectBrowser(userFor(page, prompt, true)).toHaveCount(1);
          await expectBrowser(page.locator(".chat-send-status")).toHaveCount(0);
          if (artifactDir && outcome === "duplicate") {
            const frame = await takeControlUiScreenshotFrame(
              page,
              page.locator("openclaw-chat-pane"),
              [userFor(page, prompt, true), page.locator(".chat-group.user time")],
              { animations: "disabled" },
            );
            await writeFile(path.join(artifactDir, "after-replaying-original-key.png"), frame.png);
          }
          if (outcome === "rejection") {
            await gateway.rejectDeferred("chat.send", {
              code: "INVALID_REQUEST",
              message: "Synthetic admission rejection",
            });
            const failed = page.locator('.chat-send-status[data-send-state="failed"]');
            await failed.getByText("Not sent", { exact: true }).waitFor();
            if (artifactDir) {
              const frame = await takeControlUiScreenshotFrame(
                page,
                page.locator("openclaw-chat-pane"),
                [
                  failed.getByText("Not sent", { exact: true }),
                  failed.getByRole("button", { name: "Retry queued message" }),
                ],
                { animations: "disabled" },
              );
              await writeFile(path.join(artifactDir, "after-rejection.png"), frame.png);
            }
            await gateway.deferNext("chat.send");
            await failed.getByRole("button", { name: "Retry queued message" }).click();
            const retry = await gateway.waitForRequest("chat.send", { after: 2 });
            const retryParams = requireRecord(retry.params);
            expect(retryParams).toEqual({
              ...nextParams,
              idempotencyKey: expect.any(String),
            });
            acceptedRunId = requireString(retryParams.idempotencyKey, "retry submission key");
            expect(acceptedRunId).not.toBe(runId);
            requestCount = 3;
          }
        }
        if (outcome === "duplicate") {
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
          await publishHistory(
            gateway,
            "different delivered turn",
            "different-run",
            "different-history-turn",
            1,
          );
          await page.locator('.chat-bubble[data-entry-id="different-history-turn"]').waitFor();
          await expectBrowser(page.locator(".chat-send-status")).toHaveCount(0);
          await page.locator(".chat-group.user", { hasText: prompt }).locator("time").waitFor();
          await expectBrowser(userFor(page, prompt, true)).toHaveCount(1);
          await expectRequestCountStable(gateway, "chat.send", 2);

          await publishHistory(gateway, prompt, runId, "accepted-history-turn", 2);
          const durableBubble = page.locator(
            '.chat-group.user .chat-bubble[data-entry-id="accepted-history-turn"]',
          );
          await durableBubble.waitFor();
          await expectBrowser(userFor(page, prompt, true)).toHaveCount(1);
          const displayMatch = { sessionKey: "agent:main:main", limit: 80 };
          const refreshBefore = (await gateway.getRequests("chat.history", displayMatch)).length;
          await gateway.deferNext("chat.history", displayMatch);
          await gateway.resolveDeferred("chat.send", {
            runId: acceptedRunId,
            status: "ok",
            messageSeq: 2,
          });
          await gateway.waitForRequest("chat.history", {
            after: refreshBefore,
            match: displayMatch,
          });
          await expect.poll(async () => (await readOutboxQueue(page)).length).toBe(0);
          await expectBrowser(page.locator(".chat-send-status")).toHaveCount(0);
          expect(
            await userFor(page, prompt, true).count(),
            "The committed user row must survive duplicate ACK retirement while readback is held",
          ).toBe(1);
          expect(await durableBubble.count()).toBe(1);
          expect(await durableBubble.getByText(prompt, { exact: true }).count()).toBe(1);
          await expectRequestCountStable(gateway, "chat.send", 2);
          await gateway.resolveDeferred("chat.history");
          await expectBrowser(durableBubble).toHaveCount(1);
          await expectBrowser(userFor(page, prompt, true)).toHaveCount(1);
        } else {
          await gateway.resolveDeferred("chat.send", { runId: acceptedRunId, status: "ok" });
        }
        await expect.poll(async () => (await readOutboxQueue(page)).length).toBe(0);
        await expectBrowser(page.locator(".chat-send-status")).toHaveCount(0);
        await expectRequestCountStable(gateway, "chat.send", requestCount);
        expect(
          (await gateway.getRequests("chat.history")).some(
            (request) => requireRecord(request.params).limit === 1000,
          ),
        ).toBe(false);
      }),
  );
});
