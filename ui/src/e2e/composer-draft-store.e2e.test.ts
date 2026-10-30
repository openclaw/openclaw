import { Buffer } from "node:buffer";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { ChatPageHost } from "../pages/chat/chat-state-host.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  installMockGateway,
  startControlUiE2eServer,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionUrl,
} from "./chat-flow.test-support.ts";
import { verifyDurableComposerFences } from "./composer-draft-fences.test-support.ts";
import { composerStore, composerStorePage } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { navigateInApp } from "./new-session-page.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI durable composer draft storage",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

type TestDraftScope = { gatewayOwner: string; recoveryScope: string; scopeKey: string };

async function rawDraftRecords(page: Page, scopes: readonly TestDraftScope[], expire = false) {
  const helpers = await page.evaluateHandle<
    typeof import("../lib/chat/control-ui-database.runtime.ts")
  >('import("/src/lib/chat/control-ui-database.runtime.ts")');
  return page.evaluate(
    async ({ draftScopes, markExpired, helpers: { requestResult, transactionComplete } }) => {
      const database = await requestResult(indexedDB.open("openclaw-control-ui"));
      const transaction = database.transaction(
        "composerDrafts",
        markExpired ? "readwrite" : "readonly",
      );
      const store = transaction.objectStore("composerDrafts");
      const records = (await requestResult(store.getAll())) as Array<Record<string, unknown>>;
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
      await transactionComplete(transaction);
      database.close();
      return result;
    },
    { draftScopes: scopes, markExpired: expire, helpers },
  );
}

const withStore = composerStorePage(suite);

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
        await selectChatLayoutAction(page, "Open split view");
        const cells = page.locator(".chat-split-view__cell");
        const left = cells.nth(0).getByRole("textbox", { name: "Chat composer" });
        const right = cells.nth(1).getByRole("textbox", { name: "Chat composer" });
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
    await withStore(async ({ page, store: storeHandle }) => {
      const composerHandle = await page.evaluateHandle<
        typeof import("../pages/chat/composer-persistence.ts")
      >('import("/src/pages/chat/composer-persistence.ts")');
      const sessionKeyHandle = await page.evaluateHandle<
        typeof import("../lib/sessions/session-key.ts")
      >('import("/src/lib/sessions/session-key.ts")');
      const scopeHandle = await page.evaluateHandle<
        typeof import("../lib/chat/outbox-store-scope.ts")
      >('import("/src/lib/chat/outbox-store-scope.ts")');
      const result = await page.evaluate(
        async ({ draftStore, sessionKeys, composer, scopes }) => {
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
            scopeKey: `chat:v3:${scopes.storedChatOutboxScopeKey(
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
            const stored = await draftStore.read(scope);
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
          await draftStore.seed(
            { ...scope, recoveryScope: "credential-b", scopeKey: "reconnect-barrier" },
            "barrier",
            1,
            "reconnect-barrier",
          );
          return draftStore.read(scope);
        },
        {
          draftStore: storeHandle,
          sessionKeys: sessionKeyHandle,
          composer: composerHandle,
          scopes: scopeHandle,
        },
      );

      expect(result).toMatchObject({
        status: "found",
        draft: { text: "authenticated offline draft" },
      });
    }, "chat");
  });

  it("migrates identifiable attachment drafts and atomically retains failed or conflicting recovery", async () => {
    await withStore(async ({ page, store: handle }) => {
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
          await store.seed(scope, "saved attachment draft", 42, "legacy", [attachment]);
        }
        const migrated = await store.prepare(owner);
        if (migrated.status !== "ready" || migrated.entries.length !== 1) {
          throw new Error("Expected one ambiguous draft");
        }
        const entry = migrated.entries[0]!;
        const canonical = { ...owner, scopeKey: "chat:v3:agent:work:main\u0000agent:work" };
        const identified = await store.read(canonical);
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
        const failed = await store.restore(destination, entry, 0, undefined, () => true, 0);
        IDBObjectStore.prototype.put = originalPut;
        const afterFailure = await store.read(ambiguous);
        const failedDestination = await store.read(destination);
        await store.seed(destination, "newer destination", 50, "newer");
        const conflict = await store.restore(destination, entry, 0, undefined, () => true, 0);
        const newer = await store.read(destination);
        const fence = await store.retire(destination, 50);
        if (fence.status !== "persisted" || fence.revision === undefined) {
          throw new Error("Missing destination fence");
        }
        const staleOwner = await store.restore(
          destination,
          entry,
          fence.revision!,
          fence.writeId,
          () => false,
          0,
        );
        const restored = await store.restore(
          destination,
          entry,
          fence.revision!,
          fence.writeId,
          () => true,
          fence.revision!,
        );
        const recovered = await store.read(destination);
        const sourceAfter = await store.read(ambiguous);
        // A downgraded reader can start a new draft behind the source tombstone.
        const oldFence = await store.read(qualified);
        if (oldFence.status !== "not-found" || oldFence.revision === undefined) {
          throw new Error("Missing legacy fence");
        }
        await store.write(
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
        const reopened = await store.prepare(owner);
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
    await withStore(async ({ context, page, store: seedStoreHandle }) => {
      const scope = {
        gatewayOwner: "foreground-gateway",
        recoveryScope: "foreground-credential",
        scopeKey: "foreground-draft",
      };

      await page.evaluate(
        ({ draftScope, draftStore }) =>
          draftStore.seed(draftScope, "restore before maintenance", 1, "foreground-write"),
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
      const reopenedStoreHandle = await composerStore(reopened);
      const result = await reopened.evaluate(
        ({ draftScope, draftStore }) =>
          Promise.race([
            draftStore.read(draftScope),
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
    });
  });

  it("retires context-only comments with their conversation without resurrecting stale edits", async () => {
    await withStore(async ({ page, store: storeHandle }) => {
      const result = await page.evaluate(async (store) => {
        const parent = {
          gatewayOwner: "comments-fixture",
          recoveryScope: "person-a",
          scopeKey: "chat:v3:agent:main:one\0agent:main",
        };
        const scope = { ...parent, scopeKey: `comments:v1:${parent.scopeKey}` };
        const draft = {
          revision: 1,
          text: "",
          attachments: [],
          selectionAnnotations: [
            {
              text: "quoted text",
              comment: "unsent comment",
              start: 0,
              end: 11,
              sessionKey: "agent:main:one",
              messageId: "message-one",
              entryId: "entry-one",
            },
          ],
        };
        await store.write(scope, draft, { expectedRevision: 0, writeId: "first" });
        const recovery = await store.prepare(parent);
        const read = await store.read(scope);
        const other = await store.read({ ...scope, recoveryScope: "person-b" });
        await store.retire(parent);
        return {
          recovery,
          read,
          other,
          retired: await store.read(scope),
          stale: await store.write(
            scope,
            { ...draft, revision: 2 },
            { expectedRevision: 1, writeId: "late" },
          ),
        };
      }, storeHandle);
      expect(result.recovery).toEqual({ status: "ready", entries: [] });
      expect(result.read).toMatchObject({
        status: "found",
        draft: {
          attachments: [],
          selectionAnnotations: [
            {
              text: "quoted text",
              comment: "unsent comment",
              start: 0,
              end: 11,
              messageId: "message-one",
              entryId: "entry-one",
            },
          ],
        },
      });
      expect(result.other.status).toBe("not-found");
      expect(result.retired.status).toBe("not-found");
      expect(result.stale.status).toBe("conflict");
    });
  });

  it("keeps question drafts scoped, bounded, and retired with their conversation", async () => {
    await withStore(async ({ page, store: storeHandle }) => {
      const result = await page.evaluate(async (store) => {
        const parent = {
          gatewayOwner: "question-fixture",
          recoveryScope: "person-a",
          scopeKey: "chat:v3:agent:main:one\u0000agent:main",
        };
        const scope = { ...parent, scopeKey: `questions:v1:${parent.scopeKey}` };
        const payload = {
          text: "",
          attachments: [],
          questionDrafts: [
            {
              itemId: "audience",
              signature: "fixture",
              edited: true,
              answers: [{ selected: [], freeText: "My team" }],
            },
          ],
        };
        await store.write(
          scope,
          { ...payload, revision: 1 },
          { expectedRevision: 0, writeId: "first" },
        );
        const recovery = await store.prepare(parent);
        const read = await store.read(scope);
        const other = await store.read({ ...scope, recoveryScope: "person-b" });
        await store.retire(parent);
        const retired = await store.read(scope);
        const stale = await store.write(
          scope,
          { ...payload, revision: 2 },
          { expectedRevision: 1, writeId: "late" },
        );
        // Distinct timestamps make eviction independent of IndexedDB key tie order.
        const boundedScopes = Array.from({ length: 21 }, (_, index) => ({
          ...scope,
          scopeKey: `questions:v1:chat:v3:agent:main:bounded-${index}\u0000agent:main`,
        }));
        const originalNow = Date.now;
        let now = originalNow();
        const writes = [];
        try {
          Date.now = () => ++now;
          for (const [index, boundedScope] of boundedScopes.entries()) {
            writes.push(
              await store.write(
                boundedScope,
                { ...payload, revision: index + 10 },
                { expectedRevision: 0, writeId: `bounded-${index}` },
              ),
            );
          }
        } finally {
          Date.now = originalNow;
        }
        const bounded = await Promise.all(
          boundedScopes.map((boundedScope) => store.read(boundedScope)),
        );
        return {
          recovery,
          read,
          other,
          retired,
          stale,
          oldest: bounded[0],
          active: bounded.filter((storedDraft) => storedDraft.status === "found").length,
          writes: writes.map((write) => write.status),
          expireScope: boundedScopes[20]!,
        };
      }, storeHandle);
      expect(result.recovery).toEqual({ status: "ready", entries: [] });
      expect(result.read).toMatchObject({
        status: "found",
        draft: { questionDrafts: [{ answers: [{ freeText: "My team" }] }] },
      });
      expect(result.other.status).toBe("not-found");
      expect(result.retired.status).toBe("not-found");
      expect(result.stale.status).toBe("conflict");
      expect(result.writes).toEqual(Array.from({ length: 21 }, () => "persisted"));
      expect(result.active).toBe(20);
      expect(result.oldest?.status).toBe("not-found");
      await rawDraftRecords(page, [result.expireScope], true);
      const expired = await page.evaluate(({ store, scope }) => store.read(scope), {
        store: storeHandle,
        scope: result.expireScope,
      });
      expect(expired.status).toBe("not-found");
    });
  });

  it("expires drafts across abandoned credential owners on the next database open", async () => {
    await withStore(async ({ page, context, store: seedStoreHandle }) => {
      const scopes = await page.evaluate(async (draftStore) => {
        const owner = { gatewayOwner: "abandoned-gateway", recoveryScope: "abandoned-credential" };
        const activeScope = { ...owner, scopeKey: "active-with-blob" };
        const tombstoneScope = { ...owner, scopeKey: "old-tombstone" };
        await draftStore.seed(activeScope, "expired abandoned draft", 10, "abandoned-active", [
          {
            blob: new Blob(["expired attachment"], { type: "text/plain" }),
            mimeType: "text/plain",
            fileName: "expired.txt",
          },
        ]);
        await draftStore.retire(tombstoneScope, 20);
        return [activeScope, tombstoneScope];
      }, seedStoreHandle);
      await rawDraftRecords(page, scopes, true);

      await page.close();
      const reopened = await context.newPage();
      await installMockGateway(reopened);
      await reopened.goto(`${suite.server.baseUrl}settings`);
      const reopenedStoreHandle = await composerStore(reopened);
      await reopened.evaluate(
        (draftStore) =>
          draftStore.read({
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
    });
  });

  it("keeps existing-session Incognito drafts in memory while preserving its submitted queue", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const ordinary = "agent:main:ordinary-draft";
        const incognito = "agent:main:dashboard:incognito-private-draft";
        const gateway = await installMockGateway(page, {
          sessionKey: ordinary,
          methodResponses: {
            "sessions.list": chatSessionListResponse([
              { key: ordinary, kind: "direct", label: "Ordinary draft", updatedAt: 2 },
              {
                key: incognito,
                kind: "direct",
                label: "Private draft",
                incognito: true,
                updatedAt: 1,
              },
            ]),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, ordinary));
        const activePane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        const composer = activePane.getByRole("textbox", { name: "Chat composer" });
        await composer.fill("Ordinary unsent draft");
        await waitForCommittedComposerDraft(
          page,
          `chat:v3:${ordinary}\u0000agent:main`,
          "Ordinary unsent draft",
          0,
        );
        await page
          .locator(
            `.sidebar-recent-session[data-session-key="${incognito}"] a.sidebar-recent-session__link`,
          )
          .click();
        await expect.poll(() => composer.inputValue()).toBe("");
        const queueHandle = await page.evaluateHandle<
          typeof import("../pages/chat/composer-queue-persistence.ts")
        >('import("/src/pages/chat/composer-queue-persistence.ts")');
        const outboxHandle = await page.evaluateHandle<
          typeof import("../lib/chat/outbox-store.ts")
        >('import("/src/lib/chat/outbox-store.ts")');
        await expect
          .poll(() =>
            activePane.evaluate((element) => {
              const { state } = element as HTMLElement & { state: ChatPageHost };
              return state.selectedChatSessionIncognito && state.client?.recoveryScopeReady;
            }),
          )
          .toBe(true);
        // A submitted, held message has a separate reload contract from unsent input.
        const admission = await page.evaluate(
          ({ queuePersistence, outbox, sessionKey }) => {
            const pane = document.querySelector<HTMLElement & { state: ChatPageHost }>(
              'openclaw-chat-pane[aria-hidden="false"]',
            );
            const state = pane?.state;
            if (
              !state ||
              state.sessionKey !== sessionKey ||
              !state.selectedChatSessionIncognito ||
              !state.client?.recoveryScopeReady ||
              !state.client.recoveryScope
            ) {
              throw new Error("Expected the authenticated Incognito composer owner");
            }
            const target = outbox.storageTargetForComposer(state);
            const admitted = queuePersistence.admitStoredChatComposerQueueItemResult(
              state,
              outbox.captureChatOutboxAdmission(state, sessionKey),
              {
                id: "held-private",
                text: "Submitted private queue entry",
                createdAt: 1,
                sendState: "held",
              },
            );
            return {
              admitted,
              storageKey: target.key,
              storageScope: JSON.stringify([target.gatewayOwner, target.recoveryScope]),
            };
          },
          { queuePersistence: queueHandle, outbox: outboxHandle, sessionKey: incognito },
        );
        expect(admission.admitted).toBe("admitted");
        await composer.fill("Private unsent draft — café 雪 🦞");
        await activePane.locator(".agent-chat__file-input").setInputFiles({
          name: "private-draft.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("Synthetic private attachment"),
        });
        await expect
          .poll(() => activePane.locator(".chat-attachment-file__name").allTextContents())
          .toContain("private-draft.txt");
        await navigateInApp(page, "appearance");
        await waitForControlUiRoute(page, {
          routeId: "appearance",
          pathname: "/settings/appearance",
        });
        await page.goBack();
        await expect.poll(() => composer.inputValue()).toBe("Private unsent draft — café 雪 🦞");
        await expect
          .poll(() => activePane.locator(".chat-attachment-file__name").allTextContents())
          .toContain("private-draft.txt");
        await waitForCommittedComposerDraft(page, `chat:v3:${incognito}\u0000agent:main`, null, 0);
        await page.reload();
        await waitForControlUiRoute(page, {
          routeId: "chat",
          pathname: new URL(controlUiSessionUrl(suite.server.baseUrl, incognito)).pathname,
        });
        await page.waitForFunction((sessionKey) => {
          const pane = document.querySelector<HTMLElement & { state?: ChatPageHost }>(
            'openclaw-chat-pane[aria-hidden="false"]',
          );
          return (
            pane?.state?.sessionKey === sessionKey &&
            pane.state.connected &&
            pane.state.selectedChatSessionIncognito
          );
        }, incognito);
        try {
          await expect.poll(() => composer.inputValue()).toBe("");
          await expect
            .poll(() => activePane.locator(".chat-attachment-file__name").count())
            .toBe(0);
        } finally {
          await captureUiProof(suite, page, "incognito-draft-reload", "reloaded.png");
        }
        const stored = await page.evaluate(
          ({ sessionKey, storageKey }) => {
            const raw = sessionStorage.getItem(storageKey);
            return raw ? JSON.parse(raw).sessions[`${sessionKey}\u0000agent:main`] : null;
          },
          { sessionKey: incognito, storageKey: admission.storageKey },
        );
        expect(stored).toMatchObject({
          queue: [
            {
              id: "held-private",
              text: "Submitted private queue entry",
              sendState: "held",
              storageScope: admission.storageScope,
            },
          ],
        });
        expect(stored.draft).toBeUndefined();
        expect(stored.draftMentions).toBeUndefined();
        expect(stored.goalMode).toBeUndefined();
        await page
          .locator(
            `.sidebar-recent-session[data-session-key="${ordinary}"] a.sidebar-recent-session__link`,
          )
          .click();
        await expect.poll(() => composer.inputValue()).toBe("Ordinary unsent draft");
        expect(
          (await gateway.getRequests()).filter(({ method }) => method === "chat.send"),
        ).toEqual([]);
      },
    );
  });

  it("fences stale writes and expires or evicts bounded durable drafts", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}chat`);
      await verifyDurableComposerFences(page);
    });
  });
});
