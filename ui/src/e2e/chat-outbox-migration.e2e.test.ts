import path from "node:path";
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
} from "./chat-flow.test-support.ts";
import {
  outboxPayloadFile as file,
  outboxPayloadHistory as history,
  outboxPaneFor as paneFor,
  outboxComposerFor as composerFor,
  countOutboxPayloads as payloadCount,
  readOutboxPayloadBytes as readPayloadBytes,
  stageOutboxAttachment as stage,
} from "./chat-outbox-payloads.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const plainHttpHost = "plain-http.test";
const suite = createChatFlowE2eSuite({
  args: [`--host-resolver-rules=MAP ${plainHttpHost} 127.0.0.1`],
});

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
    async (legacySessionKey) => {
      await suite.withPage(
        { serviceWorkers: "block", locale: "en-US", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
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
          await paneFor(page)
            .getByText("Mock Gateway: payload lifecycle proof.", { exact: true })
            .waitFor();
          await gateway.setOnline(false);
          await waitForControlUiGatewayReconnecting(page);
          await stage(page, "Mock Gateway: retained v3 Blob submission");
          await waitForCommittedComposerDraft(
            page,
            draftScope,
            "Mock Gateway: retained v3 Blob submission",
            [file.name],
          );
          await paneFor(page).getByRole("button", { name: "Send message", exact: true }).click();
          await expect.poll(async () => (await readQueue(page)).length).toBe(1);
          const original = (await readQueue(page))[0]!;
          const reference = original.attachmentPayload;
          assert(
            reference,
            "Admission must own the complete Blob before seeding the legacy envelope",
          );
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
              const [gatewayOwner, recoveryScope] = JSON.parse(item.storageScope) as [
                string,
                string,
              ];
              const currentKey = `openclaw.control.chatComposer.v4:${encodeURIComponent(gatewayOwner)}:account:${encodeURIComponent(recoveryScope)}`;
              const raw = sessionStorage.getItem(currentKey);
              if (!raw) {
                throw new Error("Missing admitted metadata");
              }
              const current = JSON.parse(raw) as {
                gatewayOwner: string;
              };
              const key = `openclaw.control.chatComposer.v3:${encodeURIComponent(current.gatewayOwner)}`;
              const { storageScope: _storageScope, ...legacyItem } = item;
              sessionStorage.setItem(
                key,
                JSON.stringify({
                  version: 3,
                  gatewayOwner: current.gatewayOwner,
                  sessions: {
                    [`${sessionKey}\u0000agent:main`]: {
                      updatedAt: 10,
                      draftRevision: 42,
                      queue: [
                        {
                          ...legacyItem,
                          sessionKey,
                          agentId: "main",
                          sendAttempts: 1,
                          sendState: "unconfirmed",
                        },
                      ],
                    },
                  },
                }),
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
          expect(await readPayloadBytes(page, reference.key)).toEqual([
            file.buffer.toString("base64"),
          ]);
          expect(await readQueue(page)).toEqual([]);
          expect(await paneFor(page).locator(".chat-queue__item").count()).toBe(0);
          expect(
            await paneFor(page).getByText("Delivery unconfirmed", { exact: true }).count(),
          ).toBe(0);
          const notice = paneFor(page).locator(".chat-outbox-recovery");
          await notice
            .locator(".chat-outbox-recovery-row")
            .getByText("Mock Gateway: retained v3 Blob submission", { exact: true })
            .waitFor();
          await expectRequestCountStable(gateway, "chat.send", 0);
          await notice.getByRole("button", { name: "Restore", exact: true }).click();
          const dialog = page.locator("openclaw-modal-dialog");
          await dialog
            .getByText(
              legacySessionKey === "global"
                ? /Add this saved copy to “Main Session”/
                : /Add this saved copy to “topic”/,
            )
            .waitFor();
          await page.screenshot({
            path: path.join(
              suite.artifactDir,
              `v3-${legacySessionKey === "global" ? "global" : "named"}-destination-confirmation.png`,
            ),
            animations: "disabled",
          });
          await dialog.getByRole("button", { name: "Restore", exact: true }).click();
          await paneFor(page).getByText("Delivery unconfirmed", { exact: true }).waitFor();
          await page.reload();
          await paneFor(page).getByText("Delivery unconfirmed", { exact: true }).waitFor();
          expect((await readQueue(page))[0]).toMatchObject({
            id: original.id,
            sessionKey: destination,
            agentId: "main",
            sendRunId: original.sendRunId,
            sendAttempts: 1,
            attachmentPayload: reference,
            storageScope: original.storageScope,
          });
          expect(await readPayloadBytes(page, reference.key)).toEqual([
            file.buffer.toString("base64"),
          ]);
          await expectRequestCountStable(gateway, "chat.send", 0);
          await page.screenshot({
            path: path.join(
              suite.artifactDir,
              `v3-${legacySessionKey === "global" ? "recovered" : "named"}-paused.png`,
            ),
            fullPage: true,
            animations: "disabled",
          });
          await paneFor(page)
            .locator(".chat-group.user")
            .getByRole("button", { name: /Retry/i })
            .click();
          const sent = await gateway.waitForRequest("chat.send");
          expect(sent.params).toMatchObject({
            sessionKey: destination,
            idempotencyKey: original.sendRunId,
            attachments: [
              {
                type: "file",
                mimeType: file.mimeType,
                fileName: file.name,
                origin: "file",
                content: file.buffer.toString("base64"),
              },
            ],
          });
          expect(requireRecord(sent.params).agentId).toBeUndefined();
          expect(await readPayloadBytes(page, reference.key)).toEqual([
            file.buffer.toString("base64"),
          ]);
          await gateway.resolveDeferred("chat.send");
          await expect.poll(async () => (await readQueue(page)).length).toBe(0);
          await expect.poll(() => payloadCount(page)).toBe(0);
          await expectRequestCountStable(gateway, "chat.send", 1);
        },
      );
    },
  );

  it("upgrades inline queues and the existing draft database, then edits and cancels without touching a newer composer", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await page.route("**/outbox-upgrade", (route) =>
        route.fulfill({ contentType: "text/html", body: "Mock upgrade seed" }),
      );
      await page.goto(`${suite.server.baseUrl}outbox-upgrade`);
      await page.evaluate(async (content) => {
        const gatewayOwner = `ws://${location.host}`;
        const scopeKey = "agent:main:main\u0000agent:main";
        sessionStorage.setItem(
          `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayOwner)}`,
          JSON.stringify({
            version: 2,
            gatewayOwner,
            sessions: {
              [scopeKey]: {
                updatedAt: Date.now(),
                queue: [
                  {
                    id: "legacy-input",
                    text: "Mock Gateway: upgrade this inline queue",
                    createdAt: Date.now(),
                    sendRunId: "legacy-idempotency",
                    sendAttempts: 0,
                    sendState: "waiting-reconnect",
                    attachments: [
                      {
                        id: "legacy-file",
                        mimeType: "text/plain",
                        fileName: "mock-original.txt",
                        dataUrl: `data:text/plain;base64,${content}`,
                      },
                    ],
                  },
                ],
              },
            },
          }),
        );
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("openclaw-control-ui", 1);
          request.onupgradeneeded = () =>
            request.result
              .createObjectStore("composerDrafts", { keyPath: "key" })
              .createIndex("ownerKey", "ownerKey");
          request.onsuccess = () => resolve(request.result);
          request.addEventListener("error", () =>
            reject(request.error ?? new Error("IndexedDB request failed")),
          );
        });
        const transaction = database.transaction("composerDrafts", "readwrite");
        const ownerKey = JSON.stringify([gatewayOwner, "e2e-recovery-scope"]);
        transaction.objectStore("composerDrafts").put({
          key: JSON.stringify([gatewayOwner, "e2e-recovery-scope", scopeKey]),
          ownerKey,
          gatewayOwner,
          recoveryScope: "e2e-recovery-scope",
          scopeKey,
          text: "Mock Gateway: old durable draft",
          revision: Date.now(),
          updatedAt: Date.now(),
          writeId: "upgrade-draft",
          attachments: [
            {
              blob: new Blob(["draft bytes"], { type: "text/plain" }),
              mimeType: "text/plain",
              fileName: "draft.txt",
            },
          ],
        });
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.addEventListener("abort", () =>
            reject(transaction.error ?? new Error("IndexedDB transaction failed")),
          );
        });
        database.close();
      }, file.buffer.toString("base64"));
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
      await expect
        .poll(() => composerFor(page).inputValue())
        .toBe("Mock Gateway: old durable draft");
      await expect.poll(() => paneFor(page).locator(".chat-attachment-thumb").count()).toBe(1);
      expect(await readQueue(page)).toEqual([]);
      expect(await paneFor(page).locator(".chat-queue__item").count()).toBe(0);
      // Recovery cannot overwrite the independently migrated durable draft.
      await composerFor(page).fill("");
      await paneFor(page).getByRole("button", { name: "Remove draft.txt", exact: true }).click();
      await waitForCommittedComposerDraft(page, "chat:v3:agent:main:main\u0000agent:main", null, 0);
      const notice = paneFor(page).locator(".chat-outbox-recovery");
      await notice
        .locator(".chat-outbox-recovery-row")
        .getByText("Mock Gateway: upgrade this inline queue", { exact: true })
        .waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);
      await notice.getByRole("button", { name: "Restore", exact: true }).click();
      const dialog = page.locator("openclaw-modal-dialog");
      await dialog.getByText(/Add this saved copy to “Main/).waitFor();
      await dialog.getByRole("button", { name: "Restore", exact: true }).click();
      await expect
        .poll(() => readQueue(page))
        .toMatchObject([{ sendRunId: "legacy-idempotency", sendAttempts: 0, sendState: "failed" }]);
      await gateway.setOnline(false);
      await waitForControlUiGatewayReconnecting(page);
      await composerFor(page).fill("Mock Gateway: newer independent draft");
      await paneFor(page)
        .locator(".agent-chat__file-input")
        .setInputFiles({
          name: "draft.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("draft bytes"),
        });
      await expect.poll(() => paneFor(page).locator(".chat-attachment-thumb").count()).toBe(1);
      const row = paneFor(page).locator(".chat-queue__item");
      await row.dblclick();
      await row.locator(".chat-queue__edit-input").fill("cancel this edit");
      await row.locator(".chat-queue__edit-cancel").click();
      expect((await readQueue(page))[0]?.text).toBe("Mock Gateway: upgrade this inline queue");
      await row.dblclick();
      await row.locator(".chat-queue__edit-input").fill("Mock Gateway: edited with original bytes");
      await row.locator(".chat-queue__edit-submit").click();
      await expect
        .poll(async () => (await readQueue(page))[0]?.text)
        .toBe("Mock Gateway: edited with original bytes");
      expect((await readQueue(page))[0]?.attachmentPayload).toBeDefined();
      expect(await composerFor(page).inputValue()).toBe("Mock Gateway: newer independent draft");
      expect(await paneFor(page).locator(".chat-attachment-thumb").count()).toBe(1);
      await expect.poll(() => payloadCount(page)).toBe(1);
      await row.getByRole("button", { name: "Remove queued message", exact: true }).click();
      await expect.poll(() => payloadCount(page)).toBe(0);
      expect(await composerFor(page).inputValue()).toBe("Mock Gateway: newer independent draft");
      await expectRequestCountStable(gateway, "chat.send", 0);
    });
  });
});
