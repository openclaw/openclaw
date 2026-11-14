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
});
