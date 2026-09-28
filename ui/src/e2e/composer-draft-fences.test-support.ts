import type { Page } from "playwright";
import { expect } from "vitest";

export async function verifyDurableComposerFences(page: Page) {
  const storeHandle = await page.evaluateHandle<
    typeof import("../lib/chat/composer-draft-store.runtime.ts")
  >('import("/src/lib/chat/composer-draft-store.runtime.ts")');
  const persistenceHandle = await page.evaluateHandle<
    typeof import("../pages/new-session/draft-persistence.ts")
  >('import("/src/pages/new-session/draft-persistence.ts")');
  const chatPersistenceHandle = await page.evaluateHandle<
    typeof import("../pages/chat/durable-composer-persistence.ts")
  >('import("/src/pages/chat/durable-composer-persistence.ts")');
  const result = await page.evaluate(
    async ({ draftStore, newSession, chatPersistence }) => {
      const waitFor = async (predicate: () => Promise<boolean>) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (await predicate()) {
            return;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
        }
        throw new Error("durable draft state did not settle");
      };
      const owner = { gatewayOwner: "test-gateway", recoveryScope: "test-credential" };
      const scope = (scopeKey: string) => ({ ...owner, scopeKey });
      const staleScope = scope("stale");
      const initial = await draftStore.writeDurableComposerDraft(
        staleScope,
        { revision: 10, text: "newer draft", attachments: [] },
        { expectedRevision: 0, writeId: "initial" },
      );
      const fenced = await draftStore.retireDurableComposerDraft(staleScope, 0, 10);
      const retired = await draftStore.retireDurableComposerDraft(staleScope, 20);
      const stale = await draftStore.writeDurableComposerDraft(
        staleScope,
        { revision: 15, text: "stale draft", attachments: [] },
        { expectedRevision: 10, writeId: "stale" },
      );
      const retiredRead = await draftStore.readDurableComposerDraft(staleScope);

      const isolationScope = scope("isolation");
      await draftStore.writeDurableComposerDraft(
        isolationScope,
        { revision: 25, text: "credential-private", attachments: [] },
        { expectedRevision: 0, writeId: "isolation" },
      );
      const wrongCredential = await draftStore.readDurableComposerDraft({
        ...isolationScope,
        recoveryScope: "other-credential",
      });
      const wrongGateway = await draftStore.readDurableComposerDraft({
        ...isolationScope,
        gatewayOwner: "other-gateway",
      });

      const lineageScope = scope("write-lineage");
      await draftStore.writeDurableComposerDraft(
        lineageScope,
        { revision: 26, text: "first writer", attachments: [] },
        { expectedRevision: 0, writeId: "first-writer" },
      );
      const wrongLineage = await draftStore.writeDurableComposerDraft(
        lineageScope,
        { revision: 27, text: "unrelated writer", attachments: [] },
        {
          expectedRevision: 26,
          expectedWriteId: "different-writer",
          writeId: "unrelated-writer",
        },
      );
      const matchingLineage = await draftStore.writeDurableComposerDraft(
        lineageScope,
        { revision: 28, text: "matching writer", attachments: [] },
        {
          expectedRevision: 26,
          expectedWriteId: "first-writer",
          writeId: "matching-writer",
        },
      );
      const localLineage = await draftStore.writeDurableComposerDraft(
        lineageScope,
        { revision: 29, text: "local successor", attachments: [] },
        {
          expectedRevision: 0,
          expectedWriteIds: ["matching-writer"],
          writeId: "local-successor",
        },
      );
      const lineageRead = await draftStore.readDurableComposerDraft(lineageScope);
      const missingPredecessor = await draftStore.writeDurableComposerDraft(
        scope("missing-predecessor"),
        { revision: 90, text: "must conflict", attachments: [] },
        { expectedRevision: 89, writeId: "missing-predecessor" },
      );

      const tooLargeBlob = new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]);
      const oversizedScope = scope("oversized");
      const oversized = await draftStore.writeDurableComposerDraft(
        oversizedScope,
        {
          revision: 30,
          text: "@Alex oversized",
          mentions: [{ profileId: "profile-alex", start: 0, end: 5 }],
          attachments: [
            {
              blob: tooLargeBlob,
              mimeType: "application/octet-stream",
            },
          ],
        },
        { expectedRevision: 0, writeId: "oversized" },
      );
      const oversizedRead = await draftStore.readDurableComposerDraft(oversizedScope);
      const oversizedState = {
        message: "",
        mentions: [{ profileId: "profile-alex", start: 0, end: 5 }],
        attachments: [] as import("../lib/chat/chat-types.ts").ChatAttachment[],
        incognito: false,
      };
      const oversizedPersistence = new newSession.NewSessionDraftPersistence(
        () => oversizedState,
        (message, attachments) => {
          oversizedState.message = message;
          oversizedState.attachments = attachments;
        },
        () => undefined,
      );
      oversizedPersistence.setOwner(oversizedScope.gatewayOwner, oversizedScope.recoveryScope);
      oversizedPersistence.activateRoute(oversizedScope.scopeKey);
      await waitFor(async () => oversizedState.message === "@Alex oversized");
      // The live composer retains the payload even though storage kept only text.
      oversizedState.attachments = await chatPersistence.hydrateDurableComposerAttachments([
        { blob: tooLargeBlob, mimeType: "application/octet-stream" },
      ]);
      const oversizedSubmission = oversizedPersistence.captureSubmission();
      oversizedPersistence.disconnect();
      await oversizedPersistence.clearSubmittedDraft(oversizedSubmission);
      const oversizedCleared = await draftStore.readDurableComposerDraft(oversizedScope);

      const oversizeConflictScope = scope("oversized-conflict");
      await draftStore.writeDurableComposerDraft(
        oversizeConflictScope,
        { revision: 50, text: "newer record", attachments: [] },
        { expectedRevision: 0, writeId: "newer-record" },
      );
      const oversizeConflict = await draftStore.writeDurableComposerDraft(
        oversizeConflictScope,
        {
          revision: 49,
          text: "stale oversized record",
          attachments: [{ blob: tooLargeBlob, mimeType: "application/octet-stream" }],
        },
        { expectedRevision: 0, writeId: "stale-oversized" },
      );
      const oversizeConflictRead = await draftStore.readDurableComposerDraft(oversizeConflictScope);

      const missingPayloadScope = scope("missing-payload-conflict");
      await draftStore.writeDurableComposerDraft(
        missingPayloadScope,
        { revision: 60, text: "newer attachment draft", attachments: [] },
        { expectedRevision: 0, writeId: "newer-attachment-draft" },
      );
      let missingPayloadErrors = 0;
      let missingPayloadConflicts = 0;
      const missingPayloadPersistence = new chatPersistence.DurableChatComposerPersistence(
        () => {
          missingPayloadErrors += 1;
        },
        () => {
          missingPayloadConflicts += 1;
        },
      );
      missingPayloadPersistence.persist({
        scope: missingPayloadScope,
        expectedRevision: 0,
        revision: 59,
        text: "stale attachment draft",
        storedAttachments: null,
        writeId: "stale-missing-payload",
      });
      await waitFor(async () => {
        const read = await draftStore.readDurableComposerDraft(missingPayloadScope);
        return read.status === "not-found" || missingPayloadConflicts > 0;
      });
      const missingPayloadRead = await draftStore.readDurableComposerDraft(missingPayloadScope);

      type DraftState = {
        message: string;
        attachments: import("../lib/chat/chat-types.ts").ChatAttachment[];
        incognito: boolean;
      };
      const incognitoScope = {
        gatewayOwner: "incognito-gateway",
        recoveryScope: "incognito-credential",
        scopeKey: "incognito-route",
      };
      const incognitoState: DraftState = {
        message: "normal before incognito",
        attachments: [],
        incognito: false,
      };
      const realNow = Date.now;
      const frozenNow = realNow();
      Date.now = () => frozenNow;
      await draftStore.retireDurableComposerDraft(
        { ...incognitoScope, scopeKey: "fence-seed" },
        frozenNow + 1_000,
      );
      const incognitoPersistence = new newSession.NewSessionDraftPersistence(
        () => incognitoState,
        (message, attachments) => {
          incognitoState.message = message;
          incognitoState.attachments = attachments;
        },
        () => undefined,
      );
      incognitoPersistence.setOwner(incognitoScope.gatewayOwner, incognitoScope.recoveryScope);
      incognitoPersistence.selectRoute(incognitoScope.scopeKey);
      incognitoPersistence.noteUserMutation();
      await waitFor(async () => {
        const read = await draftStore.readDurableComposerDraft(incognitoScope);
        return read.status === "found" && read.draft.text === "normal before incognito";
      });
      incognitoState.incognito = true;
      await incognitoPersistence.setIncognito(true);
      await waitFor(async () => {
        const read = await draftStore.readDurableComposerDraft(incognitoScope);
        return read.status === "not-found" && read.revision !== undefined;
      });
      incognitoState.incognito = false;
      await incognitoPersistence.setIncognito(false);
      const incognitoAfterToggle = await draftStore.readDurableComposerDraft(incognitoScope);
      const incognitoRetainedMessage = incognitoState.message;
      if (incognitoRetainedMessage) {
        incognitoState.message = "normal after incognito";
        incognitoPersistence.noteUserMutation();
        await waitFor(async () => {
          const read = await draftStore.readDurableComposerDraft(incognitoScope);
          return read.status === "found" && read.draft.text === incognitoState.message;
        });
      }
      const incognitoRead = await draftStore.readDurableComposerDraft(incognitoScope);
      Date.now = realNow;

      const clearScope = {
        gatewayOwner: "clear-gateway",
        recoveryScope: "clear-credential",
        scopeKey: "clear-route",
      };
      await draftStore.writeDurableComposerDraft(
        clearScope,
        { revision: 70, text: "submitted draft", attachments: [] },
        { expectedRevision: 0, writeId: "submitted-draft" },
      );
      const clearState: DraftState = { message: "", attachments: [], incognito: false };
      const clearPersistence = new newSession.NewSessionDraftPersistence(
        () => clearState,
        (message, attachments) => {
          clearState.message = message;
          clearState.attachments = attachments;
        },
        () => undefined,
      );
      clearPersistence.setOwner(clearScope.gatewayOwner, clearScope.recoveryScope);
      clearPersistence.activateRoute(clearScope.scopeKey);
      await waitFor(async () => clearState.message === "submitted draft");
      clearState.message = "submitted draft after a conflict";
      clearPersistence.noteUserMutation();
      await draftStore.writeDurableComposerDraft(
        clearScope,
        { revision: 71, text: "concurrent other-tab write", attachments: [] },
        { expectedRevision: 70, writeId: "concurrent-writer" },
      );
      const submittedDraft = clearPersistence.captureSubmission();
      await waitFor(async () => {
        const read = await draftStore.readDurableComposerDraft(clearScope);
        return read.status === "found" && read.draft.text === clearState.message;
      });
      clearPersistence.disconnect();
      clearPersistence.selectRoute("another-route");
      clearState.message = "new route draft";
      await clearPersistence.clearSubmittedDraft(submittedDraft);
      const clearRead = await draftStore.readDurableComposerDraft(clearScope);

      const staleClearScope = {
        gatewayOwner: "stale-clear-gateway",
        recoveryScope: "stale-clear-credential",
        scopeKey: "stale-clear-route",
      };
      await draftStore.writeDurableComposerDraft(
        staleClearScope,
        { revision: 80, text: "submitted stale draft", attachments: [] },
        { expectedRevision: 0, writeId: "submitted-stale-draft" },
      );
      const staleClearState: DraftState = {
        message: "",
        attachments: [],
        incognito: false,
      };
      const staleClearPersistence = new newSession.NewSessionDraftPersistence(
        () => staleClearState,
        (message, attachments) => {
          staleClearState.message = message;
          staleClearState.attachments = attachments;
        },
        () => undefined,
      );
      staleClearPersistence.setOwner(staleClearScope.gatewayOwner, staleClearScope.recoveryScope);
      staleClearPersistence.activateRoute(staleClearScope.scopeKey);
      await waitFor(async () => staleClearState.message === "submitted stale draft");
      await draftStore.writeDurableComposerDraft(
        staleClearScope,
        { revision: 81, text: "newer other-tab draft", attachments: [] },
        { expectedRevision: 80, writeId: "newer-other-tab-draft" },
      );
      await staleClearPersistence.clearSubmittedDraft(staleClearPersistence.captureSubmission());
      const staleClearRead = await draftStore.readDurableComposerDraft(staleClearScope);

      const resetLineageScope = {
        gatewayOwner: "reset-lineage-gateway",
        recoveryScope: "reset-lineage-credential",
        scopeKey: "reset-lineage-route",
      };
      await draftStore.writeDurableComposerDraft(
        resetLineageScope,
        { revision: 90, text: "cached predecessor", attachments: [] },
        { expectedRevision: 0, writeId: "cached-predecessor" },
      );
      const resetLineageState: DraftState = {
        message: "",
        attachments: [],
        incognito: false,
      };
      const resetLineagePersistence = new newSession.NewSessionDraftPersistence(
        () => resetLineageState,
        (message, attachments) => {
          resetLineageState.message = message;
          resetLineageState.attachments = attachments;
        },
        () => undefined,
      );
      resetLineagePersistence.setOwner(
        resetLineageScope.gatewayOwner,
        resetLineageScope.recoveryScope,
      );
      resetLineagePersistence.activateRoute(resetLineageScope.scopeKey);
      await waitFor(async () => resetLineageState.message === "cached predecessor");
      const databaseRequest = indexedDB.open("openclaw-control-ui");
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        databaseRequest.addEventListener("success", () => resolve(databaseRequest.result), {
          once: true,
        });
        databaseRequest.addEventListener(
          "error",
          () => reject(databaseRequest.error ?? new Error("IndexedDB open failed")),
          { once: true },
        );
      });
      const deleteTransaction = database.transaction("composerDrafts", "readwrite");
      deleteTransaction
        .objectStore("composerDrafts")
        .delete(
          JSON.stringify([
            resetLineageScope.gatewayOwner,
            resetLineageScope.recoveryScope,
            resetLineageScope.scopeKey,
          ]),
        );
      await new Promise<void>((resolve, reject) => {
        deleteTransaction.addEventListener("complete", () => resolve(), { once: true });
        deleteTransaction.addEventListener(
          "error",
          () => reject(deleteTransaction.error ?? new Error("IndexedDB delete failed")),
          { once: true },
        );
      });
      database.close();
      resetLineageState.message = "draft after authoritative deletion";
      resetLineagePersistence.noteUserMutation();
      await waitFor(async () => {
        const read = await draftStore.readDurableComposerDraft(resetLineageScope);
        return read.status === "found" && read.draft.text === resetLineageState.message;
      });
      const resetLineageRead = await draftStore.readDurableComposerDraft(resetLineageScope);

      const originalNow = Date.now;
      let now = originalNow();
      const expiringScope = scope("expiring");
      await draftStore.writeDurableComposerDraft(
        expiringScope,
        { revision: 40, text: "expired", attachments: [] },
        { expectedRevision: 0, writeId: "expiring" },
      );
      Date.now = () => now + 8 * 24 * 60 * 60 * 1_000;
      const expiredRead = await draftStore.readDurableComposerDraft(expiringScope);

      Date.now = () => ++now;
      const retainedScopes = Array.from({ length: 21 }, (_, index) => scope(`active-${index}`));
      for (const [index, activeScope] of retainedScopes.entries()) {
        await draftStore.writeDurableComposerDraft(
          activeScope,
          { revision: 100 + index, text: `draft ${index}`, attachments: [] },
          { expectedRevision: 0, writeId: `active-${index}` },
        );
      }
      const retained = await Promise.all(
        retainedScopes.map((activeScope) => draftStore.readDurableComposerDraft(activeScope)),
      );
      Date.now = originalNow;
      return {
        initial: initial.status,
        fenced: fenced.status,
        retired: retired.status,
        stale: stale.status,
        retiredRead: retiredRead.status,
        wrongCredential: wrongCredential.status,
        wrongGateway: wrongGateway.status,
        wrongLineage: wrongLineage.status,
        matchingLineage: matchingLineage.status,
        localLineage: localLineage.status,
        lineageText: lineageRead.status === "found" ? lineageRead.draft.text : null,
        missingPredecessor: missingPredecessor.status,
        oversized: oversized.status,
        oversizedRead: oversizedRead.status,
        oversizedCleared: oversizedCleared.status,
        oversizedText: oversizedRead.status === "found" ? oversizedRead.draft.text : null,
        oversizedMentions: oversizedRead.status === "found" ? oversizedRead.draft.mentions : null,
        oversizedAttachmentCount:
          oversizedRead.status === "found" ? oversizedRead.draft.attachments.length : null,
        oversizeConflict: oversizeConflict.status,
        oversizeConflictRead: oversizeConflictRead.status,
        oversizeConflictText:
          oversizeConflictRead.status === "found" ? oversizeConflictRead.draft.text : null,
        missingPayloadErrors,
        missingPayloadConflicts,
        missingPayloadRead: missingPayloadRead.status,
        missingPayloadText:
          missingPayloadRead.status === "found" ? missingPayloadRead.draft.text : null,
        incognitoRetainedMessage,
        incognitoAfterToggle: incognitoAfterToggle.status,
        incognitoMessage: incognitoState.message,
        incognitoRead: incognitoRead.status,
        incognitoText: incognitoRead.status === "found" ? incognitoRead.draft.text : null,
        clearRead: clearRead.status,
        staleClearRead: staleClearRead.status,
        staleClearText: staleClearRead.status === "found" ? staleClearRead.draft.text : null,
        resetLineageRead: resetLineageRead.status,
        resetLineageText: resetLineageRead.status === "found" ? resetLineageRead.draft.text : null,
        expiredRead: expiredRead.status,
        active: retained.filter((entry) => entry.status === "found").length,
      };
    },
    {
      draftStore: storeHandle,
      newSession: persistenceHandle,
      chatPersistence: chatPersistenceHandle,
    },
  );

  expect(result).toEqual({
    initial: "persisted",
    fenced: "conflict",
    retired: "persisted",
    stale: "conflict",
    retiredRead: "not-found",
    wrongCredential: "not-found",
    wrongGateway: "not-found",
    wrongLineage: "conflict",
    matchingLineage: "persisted",
    localLineage: "persisted",
    lineageText: "local successor",
    missingPredecessor: "conflict",
    oversized: "payload-too-large",
    oversizedRead: "found",
    oversizedCleared: "not-found",
    oversizedText: "@Alex oversized",
    oversizedMentions: [{ profileId: "profile-alex", start: 0, end: 5 }],
    oversizedAttachmentCount: 0,
    oversizeConflict: "conflict",
    oversizeConflictRead: "found",
    oversizeConflictText: "newer record",
    missingPayloadErrors: 1,
    missingPayloadConflicts: 1,
    missingPayloadRead: "found",
    missingPayloadText: "newer attachment draft",
    incognitoRetainedMessage: "normal before incognito",
    incognitoAfterToggle: "not-found",
    incognitoMessage: "normal after incognito",
    incognitoRead: "found",
    incognitoText: "normal after incognito",
    clearRead: "not-found",
    staleClearRead: "found",
    staleClearText: "newer other-tab draft",
    resetLineageRead: "found",
    resetLineageText: "draft after authoritative deletion",
    expiredRead: "not-found",
    active: 20,
  });
}
