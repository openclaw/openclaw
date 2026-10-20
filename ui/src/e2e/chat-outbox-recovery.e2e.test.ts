import { expect as expectBrowser, type Locator, type Page } from "playwright/test";
import { expect, it } from "vitest";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import {
  controlUiBundledGatewayUrl,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiSessionUrl,
  chatMessage,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
  waitForRequests,
} from "./chat-flow.test-support.ts";
import { seedLegacyComposerDraft } from "./chat-outbox-legacy-draft.test-support.ts";

const suite = createChatFlowE2eSuite();
const pageOptions = { locale: "en-US", serviceWorkers: "block" as const };
const viewport = { width: 1280, height: 900 };
const composerFor = (page: Page) => page.locator(".agent-chat__composer-combobox textarea");
const userFor = (page: Page, text: string, exact = false) =>
  page.locator(".chat-group.user").getByText(text, { exact });
const button = (target: Page | Locator, name: string) =>
  target.getByRole("button", { name, exact: true });
const deliveredMessage = (
  content: string,
  runId: string,
  stamp: { id: string; seq: number; timestamp: number },
) => ({
  content,
  role: "user",
  timestamp: stamp.timestamp,
  idempotencyKey: `${runId}:user`,
  __openclaw: { id: stamp.id, seq: stamp.seq, idempotencyKey: `${runId}:user` },
});

const unconfirmedInput = (
  id: string,
  sessionKey: string,
  sendRunId: string,
  extra: Record<string, unknown>,
) => ({
  id,
  text: "Please check the deployment notes",
  createdAt: 1,
  sessionKey,
  sendRunId,
  sendAttempts: 1,
  sendState: "unconfirmed",
  ...extra,
});
async function seedComposer(
  page: Page,
  version: number,
  data: Record<string, unknown>,
  options: { marker?: string; account?: boolean } = {},
) {
  const gatewayUrl = controlUiBundledGatewayUrl(suite.server.baseUrl);
  await page.addInitScript(
    ({ gatewayUrl: owner, version: format, data: state, marker, account }) => {
      if (marker && sessionStorage.getItem(marker)) {
        return;
      }
      if (marker) {
        sessionStorage.setItem(marker, "yes");
      }
      const key = `openclaw.control.chatComposer.v${format}:${encodeURIComponent(owner)}${account ? ":account:e2e-recovery-scope" : ""}`;
      sessionStorage.setItem(
        key,
        JSON.stringify({ version: format, gatewayOwner: owner, ...state }),
      );
    },
    { gatewayUrl, version, data, ...options },
  );
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

  it("retires a delivered recovery row when its exact submission loads in history", () =>
    suite.withPage(pageOptions, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, { sessionKey, historyMessages: [] });
      await seedComposer(
        page,
        4,
        {
          sessions: {},
          recovery: {
            delivered: {
              sourceVersion: 4,
              sourceScopeKey: `${sessionKey}\u0000agent:main`,
              session: {
                updatedAt: 1790955600000,
                queue: [
                  unconfirmedInput("delivered-input", sessionKey, "delivered-attempt", {
                    sessionId: `session:${sessionKey}`,
                  }),
                ],
              },
            },
          },
        },
        { account: true },
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const row = page.locator(".chat-outbox-recovery-row");
      await row.getByText("Please check the deployment notes", { exact: true }).waitFor();
      await gateway.setHistoryMessages([
        {
          role: "user",
          content: "Please check the deployment notes",
          __openclaw: { id: "delivered-message", seq: 1, idempotencyKey: "delivered-attempt:user" },
        },
      ]);
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        messageId: "delivered-message",
        messageSeq: 1,
        hasActiveRun: false,
        status: "done",
      });
      await userFor(page, "Please check the deployment notes", true).waitFor();
      await row.waitFor({ state: "detached" });
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(
        await page.evaluate(
          (gatewayUrl) =>
            JSON.parse(
              sessionStorage.getItem(
                `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayUrl)}:account:e2e-recovery-scope`,
              ) ?? '{"recovery":{}}',
            ).recovery,
          controlUiBundledGatewayUrl(suite.server.baseUrl),
        ),
      ).toEqual({});
    }));

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
          const differentTimestamp = Date.now();
          await gateway.setHistoryMessages([
            deliveredMessage("different delivered turn", "different-run", {
              id: "different-history-turn",
              seq: 1,
              timestamp: differentTimestamp,
            }),
          ]);
          await gateway.emitGatewayEvent("session.message", {
            hasActiveRun: false,
            messageId: "different-history-turn",
            messageSeq: 1,
            sessionKey: "main",
            status: "done",
          });
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
          const acceptedTimestamp = Date.now();
          await gateway.setHistoryMessages([
            deliveredMessage(prompt, runId, {
              id: "accepted-history-turn",
              seq: 2,
              timestamp: acceptedTimestamp,
            }),
          ]);
          await gateway.emitGatewayEvent("session.message", {
            clientRunId: runId,
            hasActiveRun: true,
            messageId: "accepted-history-turn",
            messageSeq: 2,
            sessionKey: "main",
            status: "running",
          });
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

  it("keeps a legacy uncertain send unsent until destination confirmation and explicit Retry", () =>
    suite.withPage({ ...pageOptions, viewport }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, { sessionKey });
      await seedComposer(
        page,
        2,
        {
          sessions: {
            "global\u0000agent:main": {
              updatedAt: 1790955600000,
              queue: [
                unconfirmedInput("old-followup", "global", "old-attempt", { agentId: "main" }),
              ],
            },
          },
        },
        { marker: "outbox-recovery-seeded" },
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const notice = page.locator(".agent-chat__composer-shell .chat-outbox-recovery");
      await notice
        .locator(".chat-outbox-recovery-row")
        .getByText("Please check the deployment notes")
        .waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);

      await button(notice, "Restore").click();
      const dialog = page.locator("openclaw-modal-dialog");
      await dialog.getByText(/Add this saved copy to “Main/).waitFor();
      await dialog.getByText(/Check the original chat before sending it again/).waitFor();

      await button(dialog, "Restore").click();
      await userFor(page, "Please check the deployment notes").waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);
      await page.reload();
      await userFor(page, "Please check the deployment notes").waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);

      await page.locator(".chat-group.user").getByRole("button", { name: /Retry/i }).click();
      const request = await gateway.waitForRequest("chat.send");
      expect(requireRecord(request.params)).toMatchObject({
        sessionKey,
        message: "Please check the deployment notes",
      });
      expect(
        (await gateway.getRequests("chat.history")).every(
          (historyRequest) => requireRecord(historyRequest.params).sessionKey === sessionKey,
        ),
      ).toBe(true);
    }));
  it.each(["agent:main:main", "global", "agent:work:workspace"])(
    "keeps exact history and send targets for %s across offline reload and agent navigation",
    (sessionKey) =>
      suite.withPage(pageOptions, async ({ page }) => {
        const otherKey = "agent:other:thread";
        const mainKey = sessionKey.endsWith(":workspace") ? "workspace" : "main";
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessionScope: sessionKey === "global" ? "global" : "per-sender",
          mainSessionKey: sessionKey === "global" ? "global" : `agent:main:${mainKey}`,
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey,
              scope: sessionKey === "global" ? "global" : "per-sender",
              agents: ["main", "other", "work"].map((id) => ({
                id,
                name: id,
                model: { primary: "openai/gpt-5.5" },
              })),
            },
          },
          sessions: [sessionKey, otherKey].map((key) => ({
            key,
            kind: key === "global" ? "global" : "direct",
            label: key,
            updatedAt: 1,
            hasActiveRun: false,
            activeRunIds: [],
          })),
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const composer = composerFor(page);
        await composer.waitFor();
        await gateway.setOnline(false);
        await page.locator(".agent-chat__input--offline").waitFor();
        await composer.fill(`retain destination ${sessionKey}`);
        await page.getByRole("button", { name: "Send message" }).click();
        await page.locator(".chat-queue").getByText("Waiting for reconnect").waitFor();
        expect(await userFor(page, `retain destination ${sessionKey}`).count()).toBe(0);
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, otherKey));
        await gateway.setOnline(true);
        await composerFor(page).waitFor();
        const request = await gateway.waitForRequest("chat.send");
        expect(requireRecord(request.params)).toMatchObject({
          sessionKey,
          message: `retain destination ${sessionKey}`,
          ...(sessionKey === "global" ? { agentId: "main" } : {}),
        });
        const history = (await gateway.getRequests("chat.history"))
          .map((historyRequest) => requireRecord(historyRequest.params))
          .filter((params) => params.limit === 1000);
        expect(history.length).toBeGreaterThan(0);
        expect(
          history.every(
            (params) =>
              params.sessionKey === sessionKey &&
              (sessionKey !== "global" || params.agentId === "main"),
          ),
        ).toBe(true);
      }),
  );

  it("recovers an ambiguous IndexedDB attachment draft through rendered controls without sending", () =>
    suite.withPage({ ...pageOptions, viewport }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      const gatewayAddress = controlUiBundledGatewayUrl(suite.server.baseUrl);
      // Seed the legacy database before app boot can open the current version.
      await page.route("**/outbox-recovery-seed", (route) =>
        route.fulfill({ contentType: "text/html", body: "Mock recovery seed" }),
      );
      await page.goto(`${suite.server.baseUrl}outbox-recovery-seed`);
      const seededDatabaseVersion = await seedLegacyComposerDraft(page, {
        gatewayOwner: gatewayAddress,
        scopeKey: "global\u0000agent:main",
        text: "Review the attached deployment note",
        revision: 42,
        writeId: "legacy-attachment",
        attachment: { content: "deployment note", fileName: "legacy-note.txt", sizeBytes: 15 },
      });
      expect(seededDatabaseVersion).toBe(1);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const notice = page.locator(".chat-outbox-recovery");
      await notice
        .locator(".chat-outbox-recovery-row")
        .getByText("Review the attached deployment note", { exact: true })
        .waitFor();
      await button(notice, "Restore").click();
      await button(page.locator("openclaw-modal-dialog"), "Restore").click();
      const composer = composerFor(page);
      const attachment = page
        .locator(".chat-attachments-preview .chat-attachment-file__name")
        .getByText("legacy-note.txt", { exact: true });
      await expect.poll(() => composer.inputValue()).toBe("Review the attached deployment note");
      await attachment.waitFor();
      await page.reload();
      await expect.poll(() => composer.inputValue()).toBe("Review the attached deployment note");
      await attachment.waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);
    }));

  it("shows only meaningful saved drafts and deletes a reviewed copy without sending", () =>
    suite.withPage({ ...pageOptions, viewport }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      const sessions: Record<string, { updatedAt: number; draftRevision: number; draft?: string }> =
        Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [
            `agent:main:old-${index}\u0000agent:main`,
            { updatedAt: 1790955600000, draftRevision: 42 },
          ]),
        );
      sessions["global\u0000agent:main"] = {
        updatedAt: 1790955600000,
        draftRevision: 43,
        draft: "Could you summarize the latest test results?",
      };
      await seedComposer(
        page,
        4,
        { sessions, recovery: {} },
        { marker: "saved-draft-notice-seeded" },
      );
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      const notice = page.locator(".chat-outbox-recovery");
      await notice
        .locator(".chat-outbox-recovery-row")
        .getByText("Could you summarize the latest test results?", { exact: true })
        .waitFor();
      expect(await notice.locator(".chat-outbox-recovery-row").count()).toBe(1);
      await page.emulateMedia({ colorScheme: "dark" });
      await page.waitForFunction(() => document.documentElement.dataset.themeMode === "dark");
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
      await notice.getByText("Draft", { exact: true }).waitFor();
      expect(await notice.getByText("Unsent", { exact: true }).count()).toBe(0);
      await button(notice, "Delete").click();
      const dialog = page.locator("openclaw-modal-dialog");
      await button(dialog, "Cancel").click();
      expect(await notice.locator(".chat-outbox-recovery-row").count()).toBe(1);
      await button(notice, "Delete").click();
      await button(dialog, "Delete").click();
      await notice.waitFor({ state: "detached" });
      await page.reload();
      await composerFor(page).waitFor();
      expect(await notice.count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    }));
});
