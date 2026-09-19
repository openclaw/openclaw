import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionUrl,
} from "./chat-flow.test-support.ts";
import { verifyDurableComposerFences } from "./composer-draft-fences.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI durable composer draft storage",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

type TestDraftScope = { gatewayOwner: string; recoveryScope: string; scopeKey: string };

async function rawDraftRecords(page: Page, scopes: readonly TestDraftScope[], expire = false) {
  return page.evaluate(
    async ({ draftScopes, markExpired }) => {
      const requestResult = <T>(request: IDBRequest<T>, message: string) =>
        new Promise<T>((resolve, reject) => {
          request.addEventListener("success", () => resolve(request.result), { once: true });
          request.addEventListener("error", () => reject(request.error ?? new Error(message)), {
            once: true,
          });
        });
      const database = await requestResult(
        indexedDB.open("openclaw-control-ui"),
        "IndexedDB open failed",
      );
      const transaction = database.transaction(
        "composerDrafts",
        markExpired ? "readwrite" : "readonly",
      );
      const store = transaction.objectStore("composerDrafts");
      const records = (await requestResult(store.getAll(), "IndexedDB read failed")) as Array<
        Record<string, unknown>
      >;
      const result: Record<string, { text: unknown; attachments: number | null } | null> = {};
      for (const scope of draftScopes) {
        const key = JSON.stringify([scope.gatewayOwner, scope.recoveryScope, scope.scopeKey]);
        const record = records.find((candidate) => candidate.key === key);
        result[scope.scopeKey] = record
          ? {
              text: record.text,
              attachments: Array.isArray(record.attachments) ? record.attachments.length : null,
            }
          : null;
        if (record && markExpired) {
          store.put({ ...record, updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1_000 });
        }
      }
      await new Promise<void>((resolve, reject) => {
        transaction.addEventListener("complete", () => resolve(), { once: true });
        transaction.addEventListener(
          "error",
          () => reject(transaction.error ?? new Error("IndexedDB transaction failed")),
          { once: true },
        );
      });
      database.close();
      return result;
    },
    { draftScopes: scopes, markExpired: expire },
  );
}

suite.define(() => {
  it("does not replace a newer saved split draft when an older pane returns after eviction", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const sessionKey = "agent:main:session-a";
        await installMockGateway(page, {
          sessionKey,
          methodResponses: {
            "sessions.list": chatSessionListResponse(
              ["a", "b", "c", "d"].map((letter, index) => ({
                key: `agent:main:session-${letter}`,
                kind: "direct",
                label: `Session ${letter.toUpperCase()}`,
                updatedAt: 4 - index,
              })),
            ),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await page.getByRole("button", { name: "Open split view", exact: true }).click();
        const cells = page.locator(".chat-split-view__cell");
        const left = cells.nth(0).getByRole("combobox", { name: "Chat composer" });
        const right = cells.nth(1).getByRole("combobox", { name: "Chat composer" });
        await expect.poll(() => left.count()).toBe(1);
        await left.fill("OLDER LEFT DRAFT");
        const scopeKey = `chat:v3:${sessionKey}\u0000agent:main`;
        await waitForCommittedComposerDraft(page, scopeKey, "OLDER LEFT DRAFT", 0);
        await right.fill("NEWER RIGHT DRAFT");
        await waitForCommittedComposerDraft(page, scopeKey, "NEWER RIGHT DRAFT", 0);
        await left.click();
        for (const letter of ["b", "c", "d", "a"]) {
          await page
            .locator(
              `.sidebar-recent-session[data-session-key="agent:main:session-${letter}"] a.sidebar-recent-session__link`,
            )
            .click();
          await expect
            .poll(() => new URL(page.url()).pathname)
            .toBe(
              new URL(controlUiSessionUrl(suite.server.baseUrl, `agent:main:session-${letter}`))
                .pathname,
            );
        }
        await expect.poll(() => left.inputValue()).toBe("NEWER RIGHT DRAFT");
        await expect.poll(() => right.inputValue()).toBe("NEWER RIGHT DRAFT");
        await page.reload();
        await expect.poll(() => left.inputValue()).toBe("NEWER RIGHT DRAFT");
        await captureUiProof(suite, page, "split-draft-eviction", "after.png");
      },
    );
  });

  it("does not reuse a cached composer owner while reconnect authentication is unresolved", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const storeHandle = await page.evaluateHandle<
        typeof import("../lib/chat/composer-draft-store.runtime.ts")
      >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
      const composerHandle = await page.evaluateHandle<
        typeof import("../pages/chat/composer-persistence.ts")
      >('import("/src/pages/chat/composer-persistence.ts")');
      const sessionKeyHandle = await page.evaluateHandle<
        typeof import("../lib/sessions/session-key.ts")
      >('import("/src/lib/sessions/session-key.ts")');
      const result = await page.evaluate(
        async ({ draftStore, sessionKeys, composer }) => {
          const client = { recoveryScope: "credential-a", recoveryScopeReady: true };
          const state = {
            settings: { gatewayUrl: "owner-fence-gateway" },
            hello: null,
            sessionKey: "agent:main:owner-fence",
            chatMessage: "",
            chatAttachments: [],
            chatQueue: [],
            client,
            connected: true,
            selectedChatSessionIncognito: false,
          };
          const scope = {
            gatewayOwner: state.settings.gatewayUrl,
            recoveryScope: client.recoveryScope,
            scopeKey: `chat:v3:${composer.storedChatOutboxScopeKey(
              sessionKeys.resolveUiConversationIdentity(state, state.sessionKey),
            )}`,
          };
          const persistence = new composer.ChatComposerPersistence(() => state);
          persistence.start();
          state.connected = false;
          client.recoveryScopeReady = false;
          state.chatMessage = "authenticated offline draft";
          persistence.persistChangedState();
          let offlineStored = false;
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const stored = await draftStore.readDurableComposerDraft(scope);
            if (stored.status === "found" && stored.draft.text === state.chatMessage) {
              offlineStored = true;
              break;
            }
            await new Promise((resolve) => {
              setTimeout(resolve, 10);
            });
          }
          if (!offlineStored) {
            throw new Error("offline composer draft did not settle");
          }

          state.connected = true;
          state.chatMessage = "unresolved reconnect draft";
          persistence.persistChangedState();
          // Let a wrongly admitted fire-and-forget write open its transaction,
          // then commit a later transaction in the same object store as a barrier.
          await Promise.resolve();
          await draftStore.writeDurableComposerDraft(
            { ...scope, recoveryScope: "credential-b", scopeKey: "reconnect-barrier" },
            { revision: 1, text: "barrier", attachments: [] },
            { expectedRevision: 0, writeId: "reconnect-barrier" },
          );
          return draftStore.readDurableComposerDraft(scope);
        },
        { draftStore: storeHandle, sessionKeys: sessionKeyHandle, composer: composerHandle },
      );

      expect(result).toMatchObject({
        status: "found",
        draft: { text: "authenticated offline draft" },
      });
    });
  });

  it("migrates identifiable attachment drafts and atomically retains failed or conflicting recovery", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}settings`);
      const handle = await page.evaluateHandle<
        typeof import("../lib/chat/composer-draft-store.runtime.ts")
      >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
      const result = await page.evaluate(async (store) => {
        const owner = { gatewayOwner: "migration-gateway", recoveryScope: "migration-account" };
        const qualified = { ...owner, scopeKey: "agent:work:main\u0000agent:work" };
        const ambiguous = { ...owner, scopeKey: "global\u0000agent:work" };
        const attachment = {
          blob: new Blob(["preserve these bytes"], { type: "text/plain" }),
          mimeType: "text/plain",
          fileName: "saved.txt",
        };
        for (const scope of [qualified, ambiguous]) {
          await store.writeDurableComposerDraft(
            scope,
            { revision: 42, text: "saved attachment draft", attachments: [attachment] },
            { expectedRevision: 0, writeId: "legacy" },
          );
        }
        const migrated = await store.prepareDurableComposerRecovery(owner);
        if (migrated.status !== "ready" || migrated.entries.length !== 1) {
          throw new Error("Expected one ambiguous draft");
        }
        const entry = migrated.entries[0]!;
        const canonical = { ...owner, scopeKey: "chat:v3:agent:work:main\u0000agent:work" };
        const identified = await store.readDurableComposerDraft(canonical);
        const destination = { ...owner, scopeKey: "chat:v3:agent:work:review\u0000agent:work" };
        const originalPut = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put")
          ?.value as IDBObjectStore["put"];
        IDBObjectStore.prototype.put = function (value, key) {
          if (value.scopeKey === ambiguous.scopeKey) {
            throw new DOMException("quota", "QuotaExceededError");
          }
          return key === undefined
            ? originalPut.call(this, value)
            : originalPut.call(this, value, key);
        };
        const failed = await store.restoreDurableComposerRecovery(
          destination,
          entry,
          0,
          undefined,
          () => true,
          0,
        );
        IDBObjectStore.prototype.put = originalPut;
        const afterFailure = await store.readDurableComposerDraft(ambiguous);
        const failedDestination = await store.readDurableComposerDraft(destination);
        await store.writeDurableComposerDraft(
          destination,
          { revision: 50, text: "newer destination", attachments: [] },
          { expectedRevision: 0, writeId: "newer" },
        );
        const conflict = await store.restoreDurableComposerRecovery(
          destination,
          entry,
          0,
          undefined,
          () => true,
          0,
        );
        const newer = await store.readDurableComposerDraft(destination);
        const fence = await store.retireDurableComposerDraft(destination, 50);
        if (fence.status !== "persisted" || fence.revision === undefined) {
          throw new Error("Missing destination fence");
        }
        const staleOwner = await store.restoreDurableComposerRecovery(
          destination,
          entry,
          fence.revision!,
          fence.writeId,
          () => false,
          0,
        );
        const restored = await store.restoreDurableComposerRecovery(
          destination,
          entry,
          fence.revision!,
          fence.writeId,
          () => true,
          fence.revision!,
        );
        const recovered = await store.readDurableComposerDraft(destination);
        const sourceAfter = await store.readDurableComposerDraft(ambiguous);
        // A downgraded reader can start a new draft behind the source tombstone.
        const oldFence = await store.readDurableComposerDraft(qualified);
        if (oldFence.status !== "not-found" || oldFence.revision === undefined) {
          throw new Error("Missing legacy fence");
        }
        await store.writeDurableComposerDraft(
          qualified,
          {
            revision: oldFence.revision + 1,
            text: "older UI new draft",
            attachments: [attachment],
          },
          {
            expectedRevision: oldFence.revision,
            expectedWriteId: oldFence.writeId,
            writeId: "downgraded",
          },
        );
        const reopened = await store.prepareDurableComposerRecovery(owner);
        return {
          identified:
            identified.status === "found"
              ? {
                  text: identified.draft.text,
                  revision: identified.draft.revision,
                  writeId: identified.draft.writeId,
                  bytes: await identified.draft.attachments[0]!.blob.text(),
                }
              : null,
          failed: failed.status,
          afterFailure: afterFailure.status,
          failedDestination: failedDestination.status,
          conflict: conflict.status,
          newer: newer.status === "found" ? newer.draft.text : null,
          staleOwner: staleOwner.status,
          restored: restored.status,
          sourceAfter: sourceAfter.status,
          recovered:
            recovered.status === "found" ? await recovered.draft.attachments[0]!.blob.text() : null,
          reopened: reopened.status === "ready" ? reopened.entries.map((row) => row.text) : null,
        };
      }, handle);
      expect(result).toEqual({
        identified: {
          text: "saved attachment draft",
          revision: 42,
          writeId: "legacy",
          bytes: "preserve these bytes",
        },
        failed: "storage-failed",
        afterFailure: "found",
        failedDestination: "not-found",
        conflict: "conflict",
        newer: "newer destination",
        staleOwner: "conflict",
        restored: "persisted",
        sourceAfter: "not-found",
        recovered: "preserve these bytes",
        reopened: ["older UI new draft"],
      });
    });
  });

  it("reads the requested draft before global expiry maintenance settles", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block" },
      async ({ context, page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}settings`);
        const scope = {
          gatewayOwner: "foreground-gateway",
          recoveryScope: "foreground-credential",
          scopeKey: "foreground-draft",
        };
        const seedStoreHandle = await page.evaluateHandle<
          typeof import("../lib/chat/composer-draft-store.runtime.ts")
        >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
        await page.evaluate(
          ({ draftScope, draftStore }) =>
            draftStore.writeDurableComposerDraft(
              draftScope,
              { revision: 1, text: "restore before maintenance", attachments: [] },
              { expectedRevision: 0, writeId: "foreground-write" },
            ),
          { draftScope: scope, draftStore: seedStoreHandle },
        );

        await page.close();
        const reopened = await context.newPage();
        await reopened.addInitScript(() => {
          const blockedTransactions = new WeakSet<IDBTransaction>();
          const originalOpenCursor = Object.getOwnPropertyDescriptor(
            IDBObjectStore.prototype,
            "openCursor",
          )?.value as IDBObjectStore["openCursor"];
          IDBObjectStore.prototype.openCursor = function (this: IDBObjectStore, ...args) {
            if (this.name === "composerDrafts") {
              blockedTransactions.add(this.transaction);
            }
            return originalOpenCursor.apply(this, args);
          };
          IDBTransaction.prototype.addEventListener = function (
            this: IDBTransaction,
            type: string,
            listener: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions,
          ) {
            if (type === "complete" && blockedTransactions.has(this)) {
              return;
            }
            return EventTarget.prototype.addEventListener.call(this, type, listener, options);
          } as IDBTransaction["addEventListener"];
        });
        await installMockGateway(reopened);
        await reopened.goto(`${suite.server.baseUrl}settings`);
        const reopenedStoreHandle = await reopened.evaluateHandle<
          typeof import("../lib/chat/composer-draft-store.runtime.ts")
        >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
        const result = await reopened.evaluate(
          ({ draftScope, draftStore }) =>
            Promise.race([
              draftStore.readDurableComposerDraft(draftScope),
              new Promise((resolve) => {
                setTimeout(() => resolve({ status: "maintenance-blocked-read" }), 1_000);
              }),
            ]),
          { draftScope: scope, draftStore: reopenedStoreHandle },
        );

        expect(result).toMatchObject({
          status: "found",
          draft: { text: "restore before maintenance" },
        });
      },
    );
  });

  it("expires drafts across abandoned credential owners on the next database open", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block" },
      async ({ context, page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}settings`);
        const seedStoreHandle = await page.evaluateHandle<
          typeof import("../lib/chat/composer-draft-store.runtime.ts")
        >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
        const scopes = await page.evaluate(async (draftStore) => {
          const owner = {
            gatewayOwner: "abandoned-gateway",
            recoveryScope: "abandoned-credential",
          };
          const activeScope = { ...owner, scopeKey: "active-with-blob" };
          const tombstoneScope = { ...owner, scopeKey: "old-tombstone" };
          await draftStore.writeDurableComposerDraft(
            activeScope,
            {
              revision: 10,
              text: "expired abandoned draft",
              attachments: [
                {
                  blob: new Blob(["expired attachment"], { type: "text/plain" }),
                  mimeType: "text/plain",
                  fileName: "expired.txt",
                },
              ],
            },
            { expectedRevision: 0, writeId: "abandoned-active" },
          );
          await draftStore.retireDurableComposerDraft(tombstoneScope, 20);
          return [activeScope, tombstoneScope];
        }, seedStoreHandle);
        await rawDraftRecords(page, scopes, true);

        await page.close();
        const reopened = await context.newPage();
        await installMockGateway(reopened);
        await reopened.goto(`${suite.server.baseUrl}settings`);
        const reopenedStoreHandle = await reopened.evaluateHandle<
          typeof import("../lib/chat/composer-draft-store.runtime.ts")
        >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
        await reopened.evaluate(
          (draftStore) =>
            draftStore.readDurableComposerDraft({
              gatewayOwner: "current-gateway",
              recoveryScope: "current-credential",
              scopeKey: "current-draft",
            }),
          reopenedStoreHandle,
        );
        const inspected = await rawDraftRecords(reopened, scopes);

        expect(inspected).toEqual({
          "active-with-blob": { text: "", attachments: 0 },
          "old-tombstone": null,
        });
      },
    );
  });

  it("keeps existing-session Incognito drafts memory-only across restart", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      const storeHandle = await page.evaluateHandle<
        typeof import("../lib/chat/composer-draft-store.runtime.ts")
      >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
      const composerHandle = await page.evaluateHandle<
        typeof import("../pages/chat/composer-persistence.ts")
      >('import("/src/pages/chat/composer-persistence.ts")');
      const sessionKeyHandle = await page.evaluateHandle<
        typeof import("../lib/sessions/session-key.ts")
      >('import("/src/lib/sessions/session-key.ts")');
      const durableHandle = await page.evaluateHandle<
        typeof import("../pages/chat/durable-composer-persistence.ts")
      >('import("/src/pages/chat/durable-composer-persistence.ts")');
      const result = await page.evaluate(
        async ({ draftStore, sessionKeys, composer, durable }) => {
          const waitFor = async (predicate: () => Promise<boolean>) => {
            for (let attempt = 0; attempt < 100; attempt += 1) {
              if (await predicate()) {
                return;
              }
              await new Promise((resolve) => {
                setTimeout(resolve, 10);
              });
            }
            throw new Error("existing-session Incognito draft state did not settle");
          };
          const state = {
            settings: { gatewayUrl: "incognito-chat-gateway" },
            hello: null,
            sessionKey: "agent:main:incognito-chat",
            chatMessage: "",
            chatAttachments: [] as import("../lib/chat/chat-types.ts").ChatAttachment[],
            chatQueue: [],
            client: {
              recoveryScope: "incognito-chat-credential",
              recoveryScopeReady: true,
            },
            connected: true,
            selectedChatSessionIncognito: false,
          };
          const storedScope = sessionKeys.resolveUiConversationIdentity(state, state.sessionKey);
          const scope = {
            gatewayOwner: state.settings.gatewayUrl,
            recoveryScope: state.client.recoveryScope,
            scopeKey: `chat:v3:${composer.storedChatOutboxScopeKey(storedScope)}`,
          };
          const persistence = new composer.ChatComposerPersistence(() => state);
          persistence.start();
          state.chatMessage = "private existing-session draft";
          state.chatAttachments = await durable.hydrateDurableComposerAttachments([
            {
              blob: new Blob(["private attachment"], { type: "text/plain" }),
              mimeType: "text/plain",
              fileName: "private.txt",
              sizeBytes: 18,
            },
          ]);
          persistence.schedule();
          persistence.persistNow();
          await waitFor(async () => {
            const read = await draftStore.readDurableComposerDraft(scope);
            return read.status === "found" && read.draft.attachments.length === 1;
          });

          state.selectedChatSessionIncognito = true;
          persistence.persistChangedState();
          await waitFor(async () => {
            const read = await draftStore.readDurableComposerDraft(scope);
            return read.status === "not-found" && read.revision !== undefined;
          });
          persistence.stop();

          const restartedState = {
            ...state,
            chatMessage: "",
            chatAttachments: [] as import("../lib/chat/chat-types.ts").ChatAttachment[],
          };
          const restarted = new composer.ChatComposerPersistence(() => restartedState);
          restarted.start();
          await waitFor(async () => {
            const read = await draftStore.readDurableComposerDraft(scope);
            return read.status === "not-found";
          });
          restarted.stop();
          return {
            message: restartedState.chatMessage,
            attachments: restartedState.chatAttachments.length,
          };
        },
        {
          draftStore: storeHandle,
          sessionKeys: sessionKeyHandle,
          composer: composerHandle,
          durable: durableHandle,
        },
      );

      expect(result).toEqual({ message: "", attachments: 0 });
    });
  });

  it("fences stale writes and expires or evicts bounded durable drafts", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await verifyDurableComposerFences(page);
    });
  });
});
