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
  const databaseHandle = await page.evaluateHandle<
    typeof import("../lib/chat/control-ui-database.runtime.ts")
  >('import("/src/lib/chat/control-ui-database.runtime.ts")');
  const result = await page.evaluate(
    async ({ draftStore, newSession, chatPersistence, databaseApi }) => {
      type DraftState = ReturnType<
        ConstructorParameters<typeof newSession.NewSessionDraftPersistence>[0]
      >;
      const draftState = (message = ""): DraftState => ({
        message,
        attachments: [],
        incognito: false,
      });
      const write = (
        scope: Parameters<typeof draftStore.write>[0],
        revision: number,
        text: string,
        options: Parameters<typeof draftStore.write>[2],
      ) => draftStore.write(scope, { revision, text, attachments: [] }, options);
      const draftText = (read: Awaited<ReturnType<typeof draftStore.read>>) =>
        read.status === "found" ? read.draft.text : null;
      const activate = (
        scope: Parameters<typeof draftStore.read>[0],
        state: DraftState,
        select = false,
      ) => {
        const persistence = new newSession.NewSessionDraftPersistence(
          () => state,
          (draft) => Object.assign(state, draft),
          () => undefined,
        );
        persistence.setOwner(scope.gatewayOwner, scope.recoveryScope);
        persistence[select ? "selectRoute" : "activateRoute"](scope.scopeKey);
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
      const scope = (scopeKey: string, owner = "test") => ({
        gatewayOwner: owner + "-gateway",
        recoveryScope: owner + "-credential",
        scopeKey,
      });
      const statuses = (...records: { status: string }[]) => records.map((record) => record.status);
      const waitForText = (key: Parameters<typeof draftStore.read>[0], text: () => string) =>
        waitFor(async () => draftText(await draftStore.read(key)) === text());
      const loadDraft = async (...seed: Parameters<typeof draftStore.seed>) => {
        await draftStore.seed(...seed);
        const state = draftState();
        const persistence = activate(seed[0], state);
        await waitFor(async () => state.message === seed[1]);
        return { state, persistence };
      };
      const staleScope = scope("stale");
      const initial = await draftStore.seed(staleScope, "newer draft", 10, "initial");
      const fenced = await draftStore.retire(staleScope, 0, 10);
      const retired = await draftStore.retire(staleScope, 20);
      const stale = await write(staleScope, 15, "stale draft", {
        expectedRevision: 10,
        writeId: "stale",
      });
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
      const wrongLineage = await write(lineageScope, 27, "unrelated writer", {
        expectedRevision: 26,
        expectedWriteId: "different-writer",
        writeId: "unrelated-writer",
      });
      const matchingLineage = await write(lineageScope, 28, "matching writer", {
        expectedRevision: 26,
        expectedWriteId: "first-writer",
        writeId: "matching-writer",
      });
      const localLineage = await write(lineageScope, 29, "local successor", {
        expectedRevision: 0,
        expectedWriteIds: ["matching-writer"],
        writeId: "local-successor",
      });
      const lineageRead = await draftStore.read(lineageScope);
      const missingPredecessor = await write(scope("missing-predecessor"), 90, "must conflict", {
        expectedRevision: 89,
        writeId: "missing-predecessor",
      });

      const tooLargeBlob = new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]);
      const oversizedAttachments = [{ blob: tooLargeBlob, mimeType: "application/octet-stream" }];
      const mentions = [{ profileId: "profile-alex", start: 0, end: 5 }];
      const oversizedScope = scope("oversized");
      const oversized = await draftStore.write(
        oversizedScope,
        {
          revision: 30,
          text: "@Alex oversized",
          mentions,
          attachments: oversizedAttachments,
        },
        { expectedRevision: 0, writeId: "oversized" },
      );
      const oversizedRead = await draftStore.read(oversizedScope);
      const oversizedState = { ...draftState(), mentions };
      const oversizedPersistence = activate(oversizedScope, oversizedState);
      await waitFor(async () => oversizedState.message === "@Alex oversized");
      // The live composer retains the payload even though storage kept only text.
      oversizedState.attachments =
        await chatPersistence.hydrateDurableComposerAttachments(oversizedAttachments);
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
        oversizedAttachments,
      );
      const oversizeConflictRead = await draftStore.read(oversizeConflictScope);

      const missingPayloadScope = scope("missing-payload-conflict");
      await draftStore.seed(missingPayloadScope, "newer attachment", 60, "newer-attachment");
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

      const incognitoScope = scope("incognito-route", "incognito");
      const incognitoState = draftState("before incognito");
      const realNow = Date.now;
      const frozenNow = realNow();
      Date.now = () => frozenNow;
      await draftStore.retire({ ...incognitoScope, scopeKey: "fence-seed" }, frozenNow + 1_000);
      const incognitoPersistence = activate(incognitoScope, incognitoState, true);
      incognitoPersistence.noteUserMutation();
      await waitForText(incognitoScope, () => "before incognito");
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
        incognitoState.message = "after incognito";
        incognitoPersistence.noteUserMutation();
        await waitForText(incognitoScope, () => incognitoState.message);
      }
      const incognitoRead = await draftStore.read(incognitoScope);
      Date.now = realNow;

      const clearScope = scope("clear-route", "clear");
      const clear = await loadDraft(clearScope, "submitted draft", 70, "submitted-draft");
      clear.state.message = "conflicted submission";
      clear.persistence.noteUserMutation();
      await write(clearScope, 71, "other tab write", {
        expectedRevision: 70,
        writeId: "concurrent-writer",
      });
      const submittedDraft = clear.persistence.captureSubmission();
      await waitForText(clearScope, () => clear.state.message);
      clear.persistence.disconnect();
      clear.persistence.selectRoute("another-route");
      clear.state.message = "new route draft";
      await clear.persistence.clearSubmittedDraft(submittedDraft);
      const clearRead = await draftStore.read(clearScope);

      const staleClearScope = scope("stale-clear-route", "stale-clear");
      const staleClear = await loadDraft(staleClearScope, "stale", 80, "stale-submission");
      await write(staleClearScope, 81, "newer tab draft", {
        expectedRevision: 80,
        writeId: "newer-tab",
      });
      await staleClear.persistence.clearSubmittedDraft(staleClear.persistence.captureSubmission());
      const staleClearRead = await draftStore.read(staleClearScope);

      const resetLineageScope = scope("reset-lineage-route", "reset-lineage");
      const resetLineage = await loadDraft(resetLineageScope, "cached", 90, "cached");
      const database = await databaseApi.requestResult(indexedDB.open("openclaw-control-ui"));
      const deleteTransaction = database.transaction("composerDrafts", "readwrite");
      deleteTransaction
        .objectStore("composerDrafts")
        .delete(chatPersistence.durableComposerScopeIdentity(resetLineageScope));
      await databaseApi.transactionComplete(deleteTransaction);
      database.close();
      resetLineage.state.message = "after deletion";
      resetLineage.persistence.noteUserMutation();
      await waitForText(resetLineageScope, () => resetLineage.state.message);
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
        fences: statuses(initial, fenced, retired, stale, retiredRead),
        isolation: statuses(wrongCredential, wrongGateway),
        lineage: statuses(wrongLineage, matchingLineage, localLineage, missingPredecessor),
        lineageText: draftText(lineageRead),
        oversized: statuses(oversized, oversizedRead, oversizedCleared),
        oversizedDraft:
          oversizedRead.status === "found"
            ? [
                oversizedRead.draft.text,
                oversizedRead.draft.mentions,
                oversizedRead.draft.attachments.length,
              ]
            : null,
        oversizeConflict: statuses(oversizeConflict, oversizeConflictRead),
        oversizeConflictText: draftText(oversizeConflictRead),
        missingPayload: [missingPayloadErrors, missingPayloadConflicts, missingPayloadRead.status],
        missingPayloadText: draftText(missingPayloadRead),
        incognito: statuses(incognitoAfterToggle, incognitoRead),
        incognitoMessages: [
          incognitoRetainedMessage,
          incognitoState.message,
          draftText(incognitoRead),
        ],
        clear: clearRead.status,
        staleClear: [staleClearRead.status, draftText(staleClearRead)],
        resetLineage: [resetLineageRead.status, draftText(resetLineageRead)],
        expired: expiredRead.status,
        active: retained.filter((entry) => entry.status === "found").length,
      };
    },
    {
      draftStore: storeHandle,
      newSession: persistenceHandle,
      chatPersistence: chatPersistenceHandle,
      databaseApi: databaseHandle,
    },
  );

  expect(result).toEqual({
    fences: ["persisted", "conflict", "persisted", "conflict", "not-found"],
    isolation: ["not-found", "not-found"],
    lineage: ["conflict", "persisted", "persisted", "conflict"],
    lineageText: "local successor",
    oversized: ["payload-too-large", "found", "not-found"],
    oversizedDraft: ["@Alex oversized", [{ profileId: "profile-alex", start: 0, end: 5 }], 0],
    oversizeConflict: ["conflict", "found"],
    oversizeConflictText: "newer record",
    missingPayload: [1, 1, "found"],
    missingPayloadText: "newer attachment",
    incognito: ["not-found", "found"],
    incognitoMessages: ["before incognito", "after incognito", "after incognito"],
    clear: "not-found",
    staleClear: ["found", "newer tab draft"],
    resetLineage: ["found", "after deletion"],
    expired: "not-found",
    active: 20,
  });
}
