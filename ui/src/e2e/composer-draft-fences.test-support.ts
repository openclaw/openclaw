import type { Page } from "playwright";
import { expect } from "vitest";
import { composerStore } from "./config-composer-fixtures.test-support.ts";

export async function verifyDurableComposerFences(page: Page) {
  const storeHandle = await composerStore(page);
  const persistenceHandle = await page.evaluateHandle<
    typeof import("../pages/new-session/draft-persistence.ts")
  >('import("/src/pages/new-session/draft-persistence.ts")');
  const chatPersistenceHandle = await page.evaluateHandle<
    typeof import("../pages/chat/durable-composer-persistence.ts")
  >('import("/src/pages/chat/durable-composer-persistence.ts")');
  const result = await page.evaluate(
    async ({ draftStore, newSession, chatPersistence }) => {
      type DraftState = ReturnType<
        ConstructorParameters<typeof newSession.NewSessionDraftPersistence>[0]
      >;
      const activate = (
        scope: Parameters<typeof draftStore.read>[0],
        state: DraftState,
        select = false,
      ) => {
        const persistence = new newSession.NewSessionDraftPersistence(
          () => state,
          (message, attachments) => {
            state.message = message;
            state.attachments = attachments;
          },
          () => undefined,
        );
        persistence.setOwner(scope.gatewayOwner, scope.recoveryScope);
        if (select) {
          persistence.selectRoute(scope.scopeKey);
        } else {
          persistence.activateRoute(scope.scopeKey);
        }
        return persistence;
      };
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
      const initial = await draftStore.seed(staleScope, "newer draft", 10, "initial");
      const fenced = await draftStore.retire(staleScope, 0, 10);
      const retired = await draftStore.retire(staleScope, 20);
      const stale = await draftStore.write(
        staleScope,
        { revision: 15, text: "stale draft", attachments: [] },
        { expectedRevision: 10, writeId: "stale" },
      );
      const retiredRead = await draftStore.read(staleScope);

      const isolationScope = scope("isolation");
      await draftStore.seed(isolationScope, "credential-private", 25, "isolation");
      const wrongCredential = await draftStore.read({
        ...isolationScope,
        recoveryScope: "other-credential",
      });
      const wrongGateway = await draftStore.read({
        ...isolationScope,
        gatewayOwner: "other-gateway",
      });

      const lineageScope = scope("write-lineage");
      await draftStore.seed(lineageScope, "first writer", 26, "first-writer");
      const wrongLineage = await draftStore.write(
        lineageScope,
        { revision: 27, text: "unrelated writer", attachments: [] },
        {
          expectedRevision: 26,
          expectedWriteId: "different-writer",
          writeId: "unrelated-writer",
        },
      );
      const matchingLineage = await draftStore.write(
        lineageScope,
        { revision: 28, text: "matching writer", attachments: [] },
        {
          expectedRevision: 26,
          expectedWriteId: "first-writer",
          writeId: "matching-writer",
        },
      );
      const localLineage = await draftStore.write(
        lineageScope,
        { revision: 29, text: "local successor", attachments: [] },
        {
          expectedRevision: 0,
          expectedWriteIds: ["matching-writer"],
          writeId: "local-successor",
        },
      );
      const lineageRead = await draftStore.read(lineageScope);
      const missingPredecessor = await draftStore.write(
        scope("missing-predecessor"),
        { revision: 90, text: "must conflict", attachments: [] },
        { expectedRevision: 89, writeId: "missing-predecessor" },
      );

      const tooLargeBlob = new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]);
      const oversizedScope = scope("oversized");
      const oversized = await draftStore.write(
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
      const oversizedRead = await draftStore.read(oversizedScope);
      const oversizedState = {
        message: "",
        mentions: [{ profileId: "profile-alex", start: 0, end: 5 }],
        attachments: [] as import("../lib/chat/chat-types.ts").ChatAttachment[],
        incognito: false,
      };
      const oversizedPersistence = activate(oversizedScope, oversizedState);
      await waitFor(async () => oversizedState.message === "@Alex oversized");
      // The live composer retains the payload even though storage kept only text.
      oversizedState.attachments = await chatPersistence.hydrateDurableComposerAttachments([
        { blob: tooLargeBlob, mimeType: "application/octet-stream" },
      ]);
      const oversizedSubmission = oversizedPersistence.captureSubmission();
      oversizedPersistence.disconnect();
      await oversizedPersistence.clearSubmittedDraft(oversizedSubmission);
      const oversizedCleared = await draftStore.read(oversizedScope);

      const oversizeConflictScope = scope("oversized-conflict");
      await draftStore.seed(oversizeConflictScope, "newer record", 50, "newer-record");
      const oversizeConflict = await draftStore.seed(
        oversizeConflictScope,
        "stale oversized record",
        49,
        "stale-oversized",
        [{ blob: tooLargeBlob, mimeType: "application/octet-stream" }],
      );
      const oversizeConflictRead = await draftStore.read(oversizeConflictScope);

      const missingPayloadScope = scope("missing-payload-conflict");
      await draftStore.seed(
        missingPayloadScope,
        "newer attachment draft",
        60,
        "newer-attachment-draft",
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
      await missingPayloadPersistence.persist({
        scope: missingPayloadScope,
        expectedRevision: 0,
        revision: 59,
        text: "stale attachment draft",
        storedAttachments: null,
        writeId: "stale-missing-payload",
      });
      const missingPayloadRead = await draftStore.read(missingPayloadScope);

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
      await draftStore.retire({ ...incognitoScope, scopeKey: "fence-seed" }, frozenNow + 1_000);
      const incognitoPersistence = activate(incognitoScope, incognitoState, true);
      incognitoPersistence.noteUserMutation();
      await waitFor(async () => {
        const read = await draftStore.read(incognitoScope);
        return read.status === "found" && read.draft.text === "normal before incognito";
      });
      incognitoState.incognito = true;
      await incognitoPersistence.setIncognito(true);
      await waitFor(async () => {
        const read = await draftStore.read(incognitoScope);
        return read.status === "not-found" && read.revision !== undefined;
      });
      incognitoState.incognito = false;
      await incognitoPersistence.setIncognito(false);
      const incognitoAfterToggle = await draftStore.read(incognitoScope);
      const incognitoRetainedMessage = incognitoState.message;
      if (incognitoRetainedMessage) {
        incognitoState.message = "normal after incognito";
        incognitoPersistence.noteUserMutation();
        await waitFor(async () => {
          const read = await draftStore.read(incognitoScope);
          return read.status === "found" && read.draft.text === incognitoState.message;
        });
      }
      const incognitoRead = await draftStore.read(incognitoScope);
      Date.now = realNow;

      const clearScope = {
        gatewayOwner: "clear-gateway",
        recoveryScope: "clear-credential",
        scopeKey: "clear-route",
      };
      await draftStore.seed(clearScope, "submitted draft", 70, "submitted-draft");
      const clearState: DraftState = { message: "", attachments: [], incognito: false };
      const clearPersistence = activate(clearScope, clearState);
      await waitFor(async () => clearState.message === "submitted draft");
      clearState.message = "submitted draft after a conflict";
      clearPersistence.noteUserMutation();
      await draftStore.write(
        clearScope,
        { revision: 71, text: "concurrent other-tab write", attachments: [] },
        { expectedRevision: 70, writeId: "concurrent-writer" },
      );
      const submittedDraft = clearPersistence.captureSubmission();
      await waitFor(async () => {
        const read = await draftStore.read(clearScope);
        return read.status === "found" && read.draft.text === clearState.message;
      });
      clearPersistence.disconnect();
      clearPersistence.selectRoute("another-route");
      clearState.message = "new route draft";
      await clearPersistence.clearSubmittedDraft(submittedDraft);
      const clearRead = await draftStore.read(clearScope);

      const staleClearScope = {
        gatewayOwner: "stale-clear-gateway",
        recoveryScope: "stale-clear-credential",
        scopeKey: "stale-clear-route",
      };
      await draftStore.seed(staleClearScope, "submitted stale draft", 80, "submitted-stale-draft");
      const staleClearState: DraftState = {
        message: "",
        attachments: [],
        incognito: false,
      };
      const staleClearPersistence = activate(staleClearScope, staleClearState);
      await waitFor(async () => staleClearState.message === "submitted stale draft");
      await draftStore.write(
        staleClearScope,
        { revision: 81, text: "newer other-tab draft", attachments: [] },
        { expectedRevision: 80, writeId: "newer-other-tab-draft" },
      );
      await staleClearPersistence.clearSubmittedDraft(staleClearPersistence.captureSubmission());
      const staleClearRead = await draftStore.read(staleClearScope);

      const resetLineageScope = {
        gatewayOwner: "reset-lineage-gateway",
        recoveryScope: "reset-lineage-credential",
        scopeKey: "reset-lineage-route",
      };
      await draftStore.seed(resetLineageScope, "cached predecessor", 90, "cached-predecessor");
      const resetLineageState: DraftState = {
        message: "",
        attachments: [],
        incognito: false,
      };
      const resetLineagePersistence = activate(resetLineageScope, resetLineageState);
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
        const read = await draftStore.read(resetLineageScope);
        return read.status === "found" && read.draft.text === resetLineageState.message;
      });
      const resetLineageRead = await draftStore.read(resetLineageScope);

      const originalNow = Date.now;
      let now = originalNow();
      const expiringScope = scope("expiring");
      await draftStore.seed(expiringScope, "expired", 40, "expiring");
      Date.now = () => now + 8 * 24 * 60 * 60 * 1_000;
      const expiredRead = await draftStore.read(expiringScope);

      Date.now = () => ++now;
      const retainedScopes = Array.from({ length: 21 }, (_, index) => scope(`active-${index}`));
      for (const [index, activeScope] of retainedScopes.entries()) {
        await draftStore.seed(activeScope, `draft ${index}`, 100 + index, `active-${index}`);
      }
      const retained = await Promise.all(
        retainedScopes.map((activeScope) => draftStore.read(activeScope)),
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
