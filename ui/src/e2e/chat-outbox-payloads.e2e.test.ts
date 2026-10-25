import type { BrowserContext, Page } from "playwright/test";
import { assert, expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  waitForControlUiGatewayReady,
  waitForControlUiGatewayReconnecting,
} from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import {
  holdOutboxPreviewReads,
  outboxPayloadHistory as history,
  outboxAttachment as attachment,
  expectOutboxPayload as expectPayload,
  sendOutboxMessage as send,
  outboxPageOptions as pageOptions,
  outboxPaneFor as paneFor,
  outboxComposerFor as composerFor,
  readOutboxQueue as readQueue,
  countOutboxPayloads as payloadCount,
  readOutboxPayloadBytes as readPayloadBytes,
  stageOutboxAttachment as stage,
  outboxChatUrl as chatUrl,
} from "./chat-outbox-payloads.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";

const plainHttpHost = "plain-http.test";
const suite = createChatFlowE2eSuite({
  args: [`--host-resolver-rules=MAP ${plainHttpHost} 127.0.0.1`],
});

const gatewayOptions = {
  historyMessages: history,
  sessionInfo: { key: "main", hasActiveRun: false, status: "done" },
};
const installGateway = (page: Page, deferSend = false) =>
  installMockGateway(page, {
    ...gatewayOptions,
    ...(deferSend ? { deferredMethods: ["chat.send"] } : {}),
  });
const expectAttachmentSend = (params: unknown, fields: Record<string, unknown>) =>
  expect(params).toEqual(expect.objectContaining({ ...fields, attachments: [attachment] }));
const waitForHistory = (page: Page) =>
  paneFor(page).getByText("Mock Gateway: payload lifecycle proof.", { exact: true }).waitFor();
const openChat = async (page: Page) => {
  await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
  await waitForHistory(page);
};
async function queueAttachment(page: Page, message: string) {
  await stage(page, message);
  await send(page);
  await expect.poll(async () => (await readQueue(page)).length).toBe(1);
  return (await readQueue(page))[0]!;
}
async function disconnect(page: Page, gateway: Awaited<ReturnType<typeof installGateway>>) {
  await gateway.setOnline(false);
  await waitForControlUiGatewayReconnecting(page);
}
const duplicateTab = async (context: BrowserContext, page: Page) => {
  const popup = context.waitForEvent("page");
  await page.evaluate(() => window.open("about:blank"));
  return popup;
};

suite.define(() => {
  it("automatically retries an attachment with its original key after a non-local plain HTTP reload", () =>
    suite.withPage({ ...pageOptions, locale: "en-US" }, async ({ context, page }) => {
      const url = await chatUrl(context, suite.server.baseUrl, "plain HTTP");
      const gateway = await installGateway(page, true);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await waitForControlUiGatewayReady(page);
      expect(
        await page.evaluate(() => [
          typeof indexedDB,
          isSecureContext,
          typeof navigator.locks,
          typeof crypto.randomUUID,
        ]),
      ).toEqual(["object", false, "undefined", "undefined"]);
      const message = "Mock Gateway: plain HTTP attachment";
      await stage(page, message);

      await send(page);
      const sent = await gateway.waitForRequest("chat.send");
      expectAttachmentSend(sent.params, { message });
      const original = (await readQueue(page))[0]!;
      assert(original.attachmentPayload);
      const releasePreviewReads = await holdOutboxPreviewReads(page);
      await page.reload();
      await waitForControlUiGatewayReady(page);
      await paneFor(page)
        .locator(".chat-send-status")
        .getByText("Queued", { exact: true })
        .waitFor();
      await expectRequestCountStable(gateway, "chat.send", 0);
      // Automatic replay waits for a private copy of the complete Blob payload.
      expect(await releasePreviewReads()).toBeGreaterThan(0);
      await expect
        .poll(async () => (await readQueue(page))[0]?.attachmentPayload?.key)
        .not.toBe(original.attachmentPayload.key);
      const recovered = (await readQueue(page))[0]!;
      assert(recovered.attachmentPayload);
      expect(recovered.sendRunId).toBe(original.sendRunId);
      expect(recovered.attachmentPayload.tabId).not.toBe(original.attachmentPayload.tabId);
      expect(recovered.attachmentPayload.key).not.toBe(original.attachmentPayload.key);
      await expectPayload(page, original.attachmentPayload.key);
      await expectPayload(page, recovered.attachmentPayload.key);
      const retried = await gateway.waitForRequest("chat.send");
      expect(retried.params).toEqual(sent.params);
      await gateway.resolveDeferred("chat.send");
      await expect.poll(async () => (await readQueue(page)).length).toBe(0);
      await expect.poll(() => readPayloadBytes(page, recovered.attachmentPayload!.key)).toBeNull();
      await expectPayload(page, original.attachmentPayload.key);
    }));

  it("retains offline attachment bytes through cold queue recovery and reconnect", () =>
    suite.withPage({ serviceWorkers: "block" }, async ({ context, page }) => {
      const queueModule = controlUiE2eBuiltModuleRequest(
        "ui/src/pages/chat/components/chat-composer-queue.tsx",
      );
      await page.addInitScript(() => {
        window.addEventListener("vite:preloadError", (event) => {
          console.debug(
            "outbox-preload-error: " + String((event as Event & { payload?: unknown }).payload),
          );
        });
      });
      const gateway = await installGateway(page, true);
      await openChat(page);
      await waitForControlUiGatewayReady(page);
      const message = "Mock Gateway: retain complete input while offline";
      await stage(page, message);
      await context.setOffline(true);
      await disconnect(page, gateway);
      const [failedQueueRequest] = await Promise.all([
        page.waitForEvent("requestfailed", (request) => queueModule.test(request.url())),
        page.waitForEvent(
          "console",
          (consoleMessage) =>
            consoleMessage.text().startsWith("outbox-preload-error: ") &&
            queueModule.test(consoleMessage.text()),
        ),
        send(page),
      ]);
      expect(failedQueueRequest.failure()?.errorText).toBe("net::ERR_INTERNET_DISCONNECTED");
      await expect.poll(async () => (await readQueue(page)).length).toBe(1);
      const queued = (await readQueue(page))[0]!;
      expect(queued.attachmentPayload).toBeDefined();
      expect(queued.sendAttempts).toBe(0);
      await expect.poll(() => payloadCount(page)).toBe(1);
      await expect.poll(() => composerFor(page).inputValue()).toBe("");
      await expectRequestCountStable(gateway, "chat.send", 0);
      const reloaded = page.waitForEvent("domcontentloaded");
      await context.setOffline(false);
      await reloaded;
      await gateway.setOnline(true);
      const sent = await gateway.waitForRequest("chat.send");
      expectAttachmentSend(sent.params, { message, idempotencyKey: queued.sendRunId });
      await expectRequestCountStable(gateway, "chat.send", 1);
    }));

  it("retains the full composer without sending when a real IndexedDB upgrade is blocked", () =>
    suite.withPage({ serviceWorkers: "block" }, async ({ context, page }) => {
      const blocker = await context.newPage();
      await blocker.route("**/outbox-blocker", (route) =>
        route.fulfill({ contentType: "text/html", body: "Mock storage blocker" }),
      );
      await blocker.goto(`${suite.server.baseUrl}outbox-blocker`);
      const connection = await blocker.evaluateHandle(
        async () =>
          new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open("openclaw-control-ui", 1);
            request.onupgradeneeded = () =>
              request.result
                .createObjectStore("composerDrafts", { keyPath: "key" })
                .createIndex("ownerKey", "ownerKey");
            request.onsuccess = () => resolve(request.result);
            request.addEventListener("error", () =>
              reject(request.error ?? new Error("IndexedDB request failed")),
            );
          }),
      );
      const gateway = await installGateway(page);
      await openChat(page);
      await stage(page, "Mock Gateway: retain on blocked storage");
      await send(page);
      await paneFor(page)
        .getByRole("alert")
        .filter({ hasText: "Browser attachment storage is unavailable" })
        .waitFor();
      expect(await composerFor(page).inputValue()).toBe("Mock Gateway: retain on blocked storage");
      expect(await paneFor(page).locator(".chat-attachment-thumb").count()).toBe(1);
      await expectRequestCountStable(gateway, "chat.send", 0);
      expect(await readQueue(page)).toEqual([]);
      await connection.evaluate((database) => database.close());
      await connection.dispose();
    }));

  it.each(["localhost", "plain HTTP"] as const)(
    "isolates independent and copied tabs on %s during automatic replay without foreign deletion",
    (origin) =>
      suite.withPage({ serviceWorkers: "block" }, async ({ context, page }) => {
        const url = await chatUrl(context, suite.server.baseUrl, origin);
        const gateway = await installGateway(page);
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await waitForHistory(page);
        await disconnect(page, gateway);
        const original = await queueAttachment(page, "Mock Gateway: one logical submission");
        const independent = await context.newPage();
        const independentGateway = await installGateway(independent);
        await independent.goto(url, { waitUntil: "domcontentloaded" });
        await waitForHistory(independent);
        expect(await readQueue(independent)).toEqual([]);
        await expectRequestCountStable(independentGateway, "chat.send", 0);
        const duplicate = await duplicateTab(context, page);
        const duplicateGateway = await installGateway(duplicate, true);
        await duplicate.goto(url, { waitUntil: "domcontentloaded" });
        await duplicateGateway.setOnline(true);
        expect((await duplicateGateway.waitForRequest("chat.send")).params).toMatchObject({
          idempotencyKey: original.sendRunId,
        });
        await expect
          .poll(async () => (await readQueue(duplicate))[0]?.attachmentPayload?.key)
          .not.toBe(original.attachmentPayload?.key);
        await expectRequestCountStable(duplicateGateway, "chat.send", 1);
        const copied = (await readQueue(duplicate))[0]!;
        expect(copied).toMatchObject({ id: original.id, sendRunId: original.sendRunId });
        expect(copied.attachmentPayload?.key).not.toBe(original.attachmentPayload?.key);
        await expect.poll(() => payloadCount(page)).toBe(2);
        assert(original.attachmentPayload);
        assert(copied.attachmentPayload);
        await expectPayload(duplicate, copied.attachmentPayload.key);
        const removedDuplicate = await duplicateTab(context, page);
        const removalGateway = await installGateway(removedDuplicate, true);
        await removedDuplicate.goto(url, { waitUntil: "domcontentloaded" });
        await removalGateway.setOnline(true);
        expect((await removalGateway.waitForRequest("chat.send")).params).toMatchObject({
          idempotencyKey: original.sendRunId,
        });
        await expect
          .poll(async () => (await readQueue(removedDuplicate))[0]?.attachmentPayload?.key)
          .not.toBe(original.attachmentPayload?.key);
        await expect.poll(() => payloadCount(page)).toBe(3);
        await paneFor(removedDuplicate)
          .getByRole("button", { name: "Discard", exact: true })
          .click();
        await expect.poll(() => payloadCount(page)).toBe(2);
        await expectPayload(page, original.attachmentPayload.key);
        await expectRequestCountStable(removalGateway, "chat.send", 1);
        const lateDuplicate = await duplicateTab(context, page);
        // Retiring the source releases only its own bundle, preserving the live copy.
        await paneFor(page)
          .getByRole("button", { name: /Remove queued message/ })
          .click();
        await expect.poll(() => payloadCount(page)).toBe(1);
        expect((await readQueue(duplicate))[0]?.attachmentPayload?.key).toBe(
          copied.attachmentPayload?.key,
        );
        const lateGateway = await installGateway(lateDuplicate);
        await lateDuplicate.goto(url, { waitUntil: "domcontentloaded" });
        await lateGateway.setOnline(true);
        await expect
          .poll(async () => (await readQueue(lateDuplicate))[0]?.attachmentStorageError)
          .toBe("missing");
        await expectRequestCountStable(lateGateway, "chat.send", 0);
        expect((await readQueue(lateDuplicate))[0]?.sendRunId).toBe(original.sendRunId);
      }),
  );
  it("keeps source Blob bytes when a duplicate removes its row before lock-confirmed adoption", () =>
    suite.withPage({ ...pageOptions, locale: "en-US" }, async ({ context, page }) => {
      const gateway = await installGateway(page, true);
      await openChat(page);
      await disconnect(page, gateway);
      const message = "Mock Gateway: source keeps its pre-adoption bytes";
      const original = await queueAttachment(page, message);
      assert(
        original?.attachmentPayload && original.sendRunId,
        "Expected a durable source submission",
      );
      const reference = original.attachmentPayload;
      const runId = original.sendRunId;
      const sourceLockName = `openclaw-outbox:${reference.tabId}`;
      const sourceOwnsLock = () =>
        page.evaluate(
          async (name) =>
            (await navigator.locks.query()).held?.some((lock) => lock.name === name) ?? false,
          sourceLockName,
        );
      expect(await sourceOwnsLock()).toBe(true);
      await expectPayload(page, reference.key);
      await expectRequestCountStable(gateway, "chat.send", 0);

      const duplicate = await duplicateTab(context, page);
      const releaseEvent = "openclaw-test-release-outbox-claim";
      await duplicate.addInitScript((eventName) => {
        const manager = navigator.locks;
        const nativeRequest = manager.request.bind(manager);
        let release!: () => void;
        let released = false;
        const latch = new Promise<void>((resolve) => {
          release = resolve;
        });
        window.addEventListener(
          eventName,
          () => {
            released = true;
            release();
          },
          { once: true },
        );
        function delay<T>(
          name: string,
          callback: LockGrantedCallback<T>,
        ): LockGrantedCallback<T | Promise<T>> {
          if (!name.startsWith("openclaw-outbox:")) {
            return callback;
          }
          return (lock) => {
            if (released) {
              return callback(lock);
            }
            document.documentElement.dataset.outboxClaimName = name;
            document.documentElement.dataset.outboxClaimGranted = String(lock !== null);
            document.documentElement.dataset.outboxClaimState = "blocked";
            // Native arbitration has already decided; delay only its callback delivery.
            return latch.then(() => callback(lock));
          };
        }
        function delayedRequest<T>(
          name: string,
          optionsOrCallback: LockOptions | LockGrantedCallback<T>,
          callback?: LockGrantedCallback<T>,
        ): Promise<Awaited<T>> {
          if (typeof optionsOrCallback === "function") {
            return nativeRequest(name, delay(name, optionsOrCallback));
          }
          if (!callback) {
            throw new TypeError("A Web Lock request requires a callback");
          }
          return nativeRequest(name, optionsOrCallback, delay(name, callback));
        }
        // Only this duplicate's LockManager changes; source ownership stays native.
        manager.request = delayedRequest;
      }, releaseEvent);
      const duplicateGateway = await installGateway(duplicate);
      try {
        await duplicate.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
        await duplicateGateway.setOnline(true);
        await waitForControlUiGatewayReady(duplicate);
        await duplicate.waitForFunction(
          () => document.documentElement.dataset.outboxClaimState === "blocked",
        );
        expect(
          await duplicate.evaluate(() => ({
            name: document.documentElement.dataset.outboxClaimName,
            granted: document.documentElement.dataset.outboxClaimGranted,
            marker: sessionStorage.getItem("openclaw.control.outboxTab.v1"),
          })),
        ).toEqual({ name: sourceLockName, granted: "false", marker: reference.tabId });
        expect((await readQueue(duplicate))[0]?.attachmentPayload).toEqual(reference);
        const row = paneFor(duplicate).locator(".chat-queue__item");
        await expect.poll(() => row.count()).toBe(1);

        await row.getByRole("button", { name: "Remove queued message", exact: true }).click();
        await expect.poll(async () => (await readQueue(duplicate)).length).toBe(0);
        await expect.poll(() => row.count()).toBe(0);
        await duplicate.evaluate(
          (eventName) => window.dispatchEvent(new Event(eventName)),
          releaseEvent,
        );
        await expect
          .poll(() =>
            duplicate.evaluate(async (sourceTab) => {
              const tab = sessionStorage.getItem("openclaw.control.outboxTab.v1");
              return Boolean(
                tab &&
                tab !== sourceTab &&
                (await navigator.locks.query()).held?.some(
                  (lock) => lock.name === `openclaw-outbox:${tab}`,
                ),
              );
            }, reference.tabId),
          )
          .toBe(true);
        await expectRequestCountStable(duplicateGateway, "chat.send", 0);
        expect(await sourceOwnsLock()).toBe(true);
        expect((await readQueue(page))[0]).toMatchObject({
          id: original.id,
          sendRunId: runId,
          sendAttempts: 0,
          attachmentPayload: reference,
        });
        await page.bringToFront();

        const sourceBytes = await readPayloadBytes(page, reference.key);
        assert(
          sourceBytes !== null,
          "Removing an unclaimed duplicate must not delete the source Blob",
        );
        expect(sourceBytes).toEqual([attachment.content]);
        await gateway.setOnline(true);
        const sent = await gateway.waitForRequest("chat.send");
        expectAttachmentSend(sent.params, { message, idempotencyKey: runId });
        await expectRequestCountStable(gateway, "chat.send", 1);
        await expectRequestCountStable(duplicateGateway, "chat.send", 0);
      } finally {
        await duplicate
          .evaluate((eventName) => window.dispatchEvent(new Event(eventName)), releaseEvent)
          .catch(() => undefined);
      }
    }));

  it("does not clear newer composer input while native Blob admission is waiting", () =>
    suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installGateway(page, true);
      await openChat(page);
      await stage(page, "Mock Gateway: captured before storage wait");
      const gate = await page.evaluateHandle(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("openclaw-control-ui", 2);
          request.onsuccess = () => resolve(request.result);
          request.addEventListener("error", () =>
            reject(request.error ?? new Error("IndexedDB request failed")),
          );
        });
        let hold = true;
        const transaction = database.transaction("outboxPayloads", "readwrite");
        const next = () => {
          const request = transaction.objectStore("outboxPayloads").get("hold-native-transaction");
          request.onsuccess = () => {
            if (hold) {
              next();
            }
          };
        };
        next();
        transaction.oncomplete = () => database.close();
        return {
          release: () => {
            hold = false;
          },
        };
      });
      await send(page);
      await composerFor(page).fill("Mock Gateway: newer input must survive");
      expect(await readQueue(page)).toEqual([]);
      await expectRequestCountStable(gateway, "chat.send", 0);
      await gate.evaluate((value) => value.release());
      await gate.dispose();
      const sent = await gateway.waitForRequest("chat.send");
      expectAttachmentSend(sent.params, { message: "Mock Gateway: captured before storage wait" });
      expect(await composerFor(page).inputValue()).toBe("Mock Gateway: newer input must survive");
      expect(await paneFor(page).locator(".chat-attachment-thumb").count()).toBe(0);
      const firstRunId = requireString(
        requireRecord(sent.params).idempotencyKey,
        "first send run id",
      );
      await gateway.resolveDeferred("chat.send");
      await gateway.emitChatFinal({
        runId: firstRunId,
        text: "Mock Gateway: first message completed.",
      });
      await send(page);
      const next = await gateway.waitForRequest("chat.send", { after: 1 });
      const nextParams = requireRecord(next.params);
      expect(nextParams.message).toBe("Mock Gateway: newer input must survive");
      expect(nextParams).not.toHaveProperty("attachments");
      expect(requireString(nextParams.idempotencyKey, "second send run id")).not.toBe(firstRunId);
    }));
  it("keeps another credential owner isolated and retains a corrupt bundle without sending partial content", () =>
    suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installGateway(page);
      await openChat(page);
      const hello = await evaluateControlUiContext(
        page,
        (context) => context.gateway.snapshot.hello,
      );
      assert(hello);
      await disconnect(page, gateway);
      const original = await queueAttachment(page, "Mock Gateway: credential-owned bytes");
      await gateway.setMethodResponse("connect", {
        ...hello,
        auth: { ...hello.auth, recoveryScope: "e2e-other-owner" },
      });
      await gateway.setOnline(true);
      await waitForControlUiGatewayReady(page);
      await expect
        .poll(() =>
          paneFor(page).evaluate(
            (pane) =>
              (pane as unknown as { state: { client: { recoveryScope: string } } }).state.client
                .recoveryScope,
          ),
        )
        .toBe("e2e-other-owner");
      await expect.poll(() => paneFor(page).locator(".chat-queue__item").count()).toBe(0);
      await expectRequestCountStable(gateway, "chat.send", 0);
      expect((await readQueue(page))[0]?.sendRunId).toBe(original.sendRunId);
      await page.evaluate(async () => {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("openclaw-control-ui");
          request.addEventListener("success", () => resolve(request.result));
          request.addEventListener("error", () =>
            reject(request.error ?? new Error("IDB open failed")),
          );
        });
        const transaction = database.transaction("outboxPayloads", "readwrite");
        const store = transaction.objectStore("outboxPayloads");
        const request = store.openCursor();
        request.addEventListener("success", () => {
          const cursor = request.result;
          if (!cursor) {
            return;
          }
          const record = cursor.value;
          record.attachments[0].blob = "corrupt";
          cursor.update(record);
          cursor.continue();
        });
        await new Promise<void>((resolve, reject) => {
          transaction.addEventListener("complete", () => resolve());
          transaction.addEventListener("abort", () =>
            reject(transaction.error ?? new Error("IDB abort")),
          );
        });
        database.close();
      });
      await disconnect(page, gateway);
      await gateway.setMethodResponse("connect", hello);
      await gateway.setOnline(true);
      await expect
        .poll(async () => (await readQueue(page))[0]?.attachmentStorageError)
        .toBe("missing");
      await expect
        .poll(() => page.locator("body").textContent())
        .toContain("Queued attachments are missing or unreadable");
      await expectRequestCountStable(gateway, "chat.send", 0);
      expect((await readQueue(page))[0]?.id).toBe(original.id);
    }));
});
