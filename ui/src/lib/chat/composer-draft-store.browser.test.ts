import { expect, it, onTestFinished } from "vitest";
import * as composer from "../../pages/chat/composer-persistence.ts";
import * as chatPersistence from "../../pages/chat/durable-composer-persistence.ts";
import * as newSession from "../../pages/new-session/draft-persistence.ts";
import * as sessionKeys from "../sessions/session-key.ts";
import * as draftApi from "./composer-draft-store.runtime.ts";
import * as databaseApi from "./control-ui-database.runtime.ts";
import * as scopes from "./outbox-store-scope.ts";

const namespace = `native-composer-draft-store:${crypto.randomUUID()}`;

const store = {
  read: draftApi.readDurableComposerDraft,
  write: draftApi.writeDurableComposerDraft,
  retire: draftApi.retireDurableComposerDraft,
  restore: draftApi.restoreDurableComposerRecovery,
  prepare: draftApi.prepareDurableComposerRecovery,
  seed(
    scope: Parameters<typeof draftApi.writeDurableComposerDraft>[0],
    text: string,
    revision: number,
    writeId: string,
    attachments: Parameters<typeof draftApi.writeDurableComposerDraft>[1]["attachments"] = [],
  ) {
    return draftApi.writeDurableComposerDraft(
      scope,
      { text, revision, attachments },
      { expectedRevision: 0, writeId },
    );
  },
};

async function expireDraft(scope: Parameters<typeof store.read>[0]) {
  const database = await databaseApi.requestResult(indexedDB.open("openclaw-control-ui"));
  const transaction = database.transaction("composerDrafts", "readwrite");
  const records = transaction.objectStore("composerDrafts");
  const key = JSON.stringify([scope.gatewayOwner, scope.recoveryScope, scope.scopeKey]);
  const record = await databaseApi.requestResult(records.get(key));
  records.put({ ...record, updatedAt: Date.now() - 8 * 24 * 60 * 60 * 1_000 });
  await databaseApi.transactionComplete(transaction);
  database.close();
}

it("does not reuse a cached composer owner while reconnect authentication is unresolved", async () => {
  const draftStore = store;
  const client = { recoveryScope: "credential-a", recoveryScopeReady: true };
  const state = {
    settings: { gatewayUrl: `${namespace}:owner-fence-gateway` },
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
  onTestFinished(() => persistence.stop());
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
  const result = await draftStore.read(scope);

  expect(result).toMatchObject({
    status: "found",
    draft: { text: "authenticated offline draft" },
  });
});

it("migrates identifiable attachment drafts and atomically retains failed or conflicting recovery", async () => {
  const owner = {
    gatewayOwner: `${namespace}:migration-gateway`,
    recoveryScope: "migration-account",
  };
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
  onTestFinished(() => {
    IDBObjectStore.prototype.put = originalPut;
  });
  IDBObjectStore.prototype.put = function (value, key) {
    if (value.scopeKey === ambiguous.scopeKey) {
      throw new DOMException("quota", "QuotaExceededError");
    }
    return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
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
  const result = {
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

it("retires context-only comments with their conversation without resurrecting stale edits", async () => {
  const parent = {
    gatewayOwner: `${namespace}:comments-fixture`,
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
  const result = {
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

it("keeps question drafts scoped, bounded, and retired with their conversation", async () => {
  const parent = {
    gatewayOwner: `${namespace}:question-fixture`,
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
  await store.write(scope, { ...payload, revision: 1 }, { expectedRevision: 0, writeId: "first" });
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
  onTestFinished(() => {
    Date.now = originalNow;
  });
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
  const bounded = await Promise.all(boundedScopes.map((boundedScope) => store.read(boundedScope)));
  const result = {
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
  await expireDraft(result.expireScope);
  const expired = await store.read(result.expireScope);
  expect(expired.status).toBe("not-found");
});

it("fences stale writes and expires or evicts bounded durable drafts", async () => {
  const draftStore = store;
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
    onTestFinished(() => persistence.disconnect());
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
    gatewayOwner: `${namespace}:${owner}-gateway`,
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
    gatewayOwner: `${namespace}:other-gateway`,
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
  onTestFinished(() => {
    Date.now = realNow;
  });
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
  onTestFinished(() => {
    Date.now = originalNow;
  });
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
  const result = {
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
    incognitoMessages: [incognitoRetainedMessage, incognitoState.message, draftText(incognitoRead)],
    clear: clearRead.status,
    staleClear: [staleClearRead.status, draftText(staleClearRead)],
    resetLineage: [resetLineageRead.status, draftText(resetLineageRead)],
    expired: expiredRead.status,
    active: retained.filter((entry) => entry.status === "found").length,
  };

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
});
