import type { Page } from "playwright";
import { assert, expect, it } from "vitest";
import type { ChatQueueItem } from "../lib/chat/chat-types.ts";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { seedLegacyComposerDraft } from "./chat-outbox-legacy-draft.test-support.ts";
import {
  outboxPayloadFile as file,
  outboxPayloadHistory as history,
  outboxPageOptions,
  outboxAttachment,
  outboxButton as button,
  expectOutboxPayload,
  outboxPaneFor as paneFor,
  outboxComposerFor as composerFor,
  countOutboxPayloads as payloadCount,
  stageOutboxAttachment as stage,
} from "./chat-outbox-payloads.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const retainedText = "Mock Gateway: retained v3 Blob submission";
const upgradeText = "Mock Gateway: upgrade this inline queue";
const originalBytes = file.buffer.toString("base64");
const suite = createChatFlowE2eSuite();
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;

async function restoreInput(page: Page, gateway: Gateway, text: string, destination: RegExp) {
  const notice = paneFor(page).locator(".chat-outbox-recovery");
  await notice.locator(".chat-outbox-recovery-row").getByText(text, { exact: true }).waitFor();
  await expectRequestCountStable(gateway, "chat.send", 0);
  await button(notice, "Restore").click();
  const dialog = page.locator("openclaw-modal-dialog");
  await dialog.getByText(destination).waitFor();
  await button(dialog, "Restore").click();
}

// Legacy metadata shares the v4 prefix but is not the current account's admitted queue.
async function readQueue(page: Page): Promise<ChatQueueItem[]> {
  return paneFor(page).evaluate((element) => {
    const { state } = element as HTMLElement & { state: ChatPageHost };
    const account = state.client?.recoveryScope ?? state.client?.offlineRecoveryScope;
    if (!account) {
      throw new Error("Expected the retained composer account");
    }
    const gatewayOwner = state.settings.gatewayUrl.trim() || "default";
    const key = `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayOwner)}:account:${encodeURIComponent(account)}`;
    const store = JSON.parse(sessionStorage.getItem(key) ?? '{"sessions":{}}') as {
      sessions: Record<string, { queue?: ChatQueueItem[] }>;
    };
    return Object.values(store.sessions).flatMap((session) => session.queue ?? []);
  });
}

suite.define(() => {
  it.each(["agent:main:topic", "global"])(
    "preserves landed v3 %s Blobs through migration, reload, explicit retry and retirement",
    (legacySessionKey) =>
      suite.withPage({ ...outboxPageOptions, locale: "en-US" }, async ({ page }) => {
        const pane = paneFor(page);
        const destination = legacySessionKey === "global" ? "agent:main:main" : legacySessionKey;
        const draftScope = `chat:v3:${destination}\u0000agent:main`;
        const gateway = await installMockGateway(page, {
          sessionKey: destination,
          sessions: [
            {
              key: destination,
              kind: "direct",
              updatedAt: 1,
              hasActiveRun: false,
              activeRunIds: [],
            },
          ],
          historyMessages: history,
          deferredMethods: ["chat.send"],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, destination));
        await waitForControlUiGatewayReady(page);
        await pane.getByText("Mock Gateway: payload lifecycle proof.", { exact: true }).waitFor();
        await gateway.setOnline(false);
        await waitForControlUiGatewayReconnecting(page);
        await stage(page, retainedText);
        await waitForCommittedComposerDraft(page, draftScope, retainedText, [file.name]);
        await button(pane, "Send message").click();
        await expect.poll(async () => (await readQueue(page)).length).toBe(1);
        const original = (await readQueue(page))[0]!;
        const reference = original.attachmentPayload;
        assert(reference, "Admission must own the Blob before migration");
        // Finish the durable clear before deleting v4's revision fence for the legacy seed.
        await waitForCommittedComposerDraft(page, draftScope, null, 0);
        await page.route("**/outbox-legacy-seed", (route) =>
          route.fulfill({ contentType: "text/html", body: "Synthetic v3 metadata seed" }),
        );
        // Leave the app before replacing its metadata; no old writer races the legacy producer.
        await page.goto(`${suite.server.baseUrl}outbox-legacy-seed`);
        const legacyKey = await page.evaluate(
          ({ item, sessionKey }) => {
            if (!item.storageScope) {
              throw new Error("Missing admitted account ownership");
            }
            const [gatewayOwner, recoveryScope] = JSON.parse(item.storageScope) as [string, string];
            const currentKey = `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayOwner)}:account:${encodeURIComponent(recoveryScope)}`;
            const raw = sessionStorage.getItem(currentKey);
            if (!raw) {
              throw new Error("Missing admitted metadata");
            }
            const { storageScope: _storageScope, ...legacyItem } = item;
            const queue = [
              {
                ...legacyItem,
                sessionKey,
                agentId: "main",
                sendAttempts: 1,
                sendState: "waiting-reconnect",
              },
            ];
            const session = { updatedAt: 10, draftRevision: 42, queue };
            const scopeKey = `${sessionKey}\u0000agent:main`;
            const key = `openclaw.control.chatComposer.v3:${encodeURIComponent(gatewayOwner)}`;
            sessionStorage.setItem(
              key,
              JSON.stringify({ version: 3, gatewayOwner, sessions: { [scopeKey]: session } }),
            );
            sessionStorage.removeItem(currentKey);
            return key;
          },
          { item: original, sessionKey: legacySessionKey },
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, destination));
        await gateway.setOnline(true);
        await waitForControlUiGatewayReady(page);
        await expect
          .poll(() => page.evaluate((key) => sessionStorage.getItem(key), legacyKey))
          .toBeNull();
        await expectOutboxPayload(page, reference.key);
        expect(await readQueue(page)).toEqual([]);
        expect(await pane.locator(".chat-queue__item").count()).toBe(0);
        expect(await pane.getByText("Needs review", { exact: true }).count()).toBe(0);
        await restoreInput(
          page,
          gateway,
          retainedText,
          legacySessionKey === "global"
            ? /Add this saved copy to “Main Session”/
            : /Add this saved copy to “topic”/,
        );
        const changedDestination = legacySessionKey === "global";
        const restored = pane.locator(
          changedDestination ? ".chat-queue__item" : ".chat-group.user",
          { hasText: retainedText },
        );
        const restoredState = changedDestination ? "Failed" : "Needs review";
        await restored.getByText(restoredState, { exact: true }).waitFor();
        await page.reload();
        await restored.getByText(restoredState, { exact: true }).waitFor();
        const recovered = (await readQueue(page))[0]!;
        expect(recovered).toMatchObject({
          id: original.id,
          sessionKey: destination,
          agentId: "main",
          attachmentPayload: reference,
          storageScope: original.storageScope,
        });
        expect(recovered.sendRunId).toBe(changedDestination ? undefined : original.sendRunId);
        expect(recovered.sendAttempts ?? 0).toBe(changedDestination ? 0 : 1);
        await expectOutboxPayload(page, reference.key);
        await expectRequestCountStable(gateway, "chat.send", 0);
        await restored.getByRole("button", { name: /Retry/i }).click();
        const sent = await gateway.waitForRequest("chat.send");
        expect(sent.params).toMatchObject({
          sessionKey: destination,
          attachments: [outboxAttachment],
        });
        const sentRunId = requireString(requireRecord(sent.params).idempotencyKey, "submission id");
        if (changedDestination) {
          expect(sentRunId).not.toBe(original.sendRunId);
        } else {
          expect(sentRunId).toBe(original.sendRunId);
        }
        expect(requireRecord(sent.params).agentId).toBeUndefined();
        await expectOutboxPayload(page, reference.key);
        await gateway.resolveDeferred("chat.send");
        await expect.poll(async () => (await readQueue(page)).length).toBe(0);
        await expect.poll(() => payloadCount(page)).toBe(0);
        await expectRequestCountStable(gateway, "chat.send", 1);
      }),
  );

  it("upgrades inline queues and the existing draft database, then edits and cancels without touching a newer composer", () =>
    suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const pane = paneFor(page);
      const composer = composerFor(page);
      await page.route("**/outbox-upgrade", (route) =>
        route.fulfill({ contentType: "text/html", body: "Mock upgrade seed" }),
      );
      await page.goto(`${suite.server.baseUrl}outbox-upgrade`);
      await page.evaluate(async (content) => {
        const gatewayOwner = `ws://${location.host}`;
        const scopeKey = "agent:main:main\u0000agent:main";
        const attachment = {
          id: "legacy-file",
          mimeType: "text/plain",
          fileName: "mock-original.txt",
          dataUrl: `data:text/plain;base64,${content}`,
        };
        const item = {
          id: "legacy-input",
          text: "Mock Gateway: upgrade this inline queue",
          createdAt: Date.now(),
          sendRunId: "legacy-idempotency",
          sendAttempts: 0,
          sendState: "waiting-reconnect",
          attachments: [attachment],
        };
        const sessions = { [scopeKey]: { updatedAt: Date.now(), queue: [item] } };
        sessionStorage.setItem(
          `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayOwner)}`,
          JSON.stringify({ version: 2, gatewayOwner, sessions }),
        );
      }, originalBytes);
      await seedLegacyComposerDraft(page, {
        gatewayOwner: `ws://${new URL(suite.server.baseUrl).host}`,
        scopeKey: "agent:main:main\u0000agent:main",
        text: "Mock Gateway: old durable draft",
        writeId: "upgrade-draft",
        attachment: { content: "draft bytes", fileName: "draft.txt" },
      });
      const gateway = await installMockGateway(page, {
        historyMessages: history,
        sessionInfo: {
          key: "main",
          hasActiveRun: true,
          activeRunIds: ["mock-held-run"],
          status: "running",
        },
        inFlightRun: { runId: "mock-held-run", text: "Mock Gateway: keeping upgrade queue held." },
      });
      await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
      await expect.poll(() => composer.inputValue()).toBe("Mock Gateway: old durable draft");
      await expect.poll(() => pane.locator(".chat-attachment-thumb").count()).toBe(1);
      expect(await readQueue(page)).toEqual([]);
      expect(await pane.locator(".chat-queue__item").count()).toBe(0);
      // Recovery cannot overwrite the independently migrated durable draft.
      await composer.fill("");
      await button(pane, "Remove draft.txt").click();
      await waitForCommittedComposerDraft(page, "chat:v3:agent:main:main\u0000agent:main", null, 0);
      await restoreInput(page, gateway, upgradeText, /Add this saved copy to “Main/);
      await expect
        .poll(() => readQueue(page))
        .toMatchObject([{ sendRunId: "legacy-idempotency", sendAttempts: 0, sendState: "failed" }]);
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await composer.fill("Mock Gateway: newer independent draft");
      await pane.locator(".agent-chat__file-input").setInputFiles({
        name: "draft.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("draft bytes"),
      });
      await expect.poll(() => pane.locator(".chat-attachment-thumb").count()).toBe(1);
      const row = pane.locator(".chat-queue__item");
      await row.dblclick();
      await row.locator(".chat-queue__edit-input").fill("cancel this edit");
      await row.locator(".chat-queue__edit-cancel").click();
      expect((await readQueue(page))[0]?.text).toBe(upgradeText);
      await row.dblclick();
      await row.locator(".chat-queue__edit-input").fill("Mock Gateway: edited with original bytes");
      await row.locator(".chat-queue__edit-submit").click();
      await expect
        .poll(async () => (await readQueue(page))[0]?.text)
        .toBe("Mock Gateway: edited with original bytes");
      expect((await readQueue(page))[0]?.attachmentPayload).toBeDefined();
      expect(await composer.inputValue()).toBe("Mock Gateway: newer independent draft");
      expect(await pane.locator(".chat-attachment-thumb").count()).toBe(1);
      await expect.poll(() => payloadCount(page)).toBe(1);
      await button(row, "Remove queued message").click();
      await expect.poll(() => payloadCount(page)).toBe(0);
      expect(await composer.inputValue()).toBe("Mock Gateway: newer independent draft");
      await expectRequestCountStable(gateway, "chat.send", 0);
    }));
});
