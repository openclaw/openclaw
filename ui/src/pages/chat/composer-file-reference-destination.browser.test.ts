import { expect, it, onTestFinished } from "vitest";
import {
  readDurableComposerDraft,
  writeDurableComposerDraft,
  retireDurableComposerDraft,
  restoreDurableComposerRecovery,
} from "../../lib/chat/composer-draft-store.runtime.ts";
import {
  openControlUiDatabase,
  requestResult,
  transactionComplete,
} from "../../lib/chat/control-ui-database.runtime.ts";
import { composerFileReferenceFixture } from "../../lib/chat/file-references.test-support.ts";
import { createFileReferenceDestinationFixture } from "./composer-file-reference-destination.test-support.ts";

const owner = {
  gatewayOwner: `native-reference:${crypto.randomUUID()}`,
  recoveryScope: "native-owner",
};

it("reconstructs a real editor reference from native IndexedDB after disposal", async () => {
  const scope = { ...owner, scopeKey: "chat:v3:agent:main:reference\u0000agent:main" };
  const first = createFileReferenceDestinationFixture("at file example");
  const result = first.destination.commit({
    id: "native-approval",
    snapshot: first.destination.snapshot(),
    from: 0,
    to: 15,
    text: "@src/example.ts",
    references: [composerFileReferenceFixture],
  });
  expect(result.status).toBe("committed");
  expect(
    await writeDurableComposerDraft(
      scope,
      { revision: 1, text: first.text, fileReferences: first.references, attachments: [] },
      { expectedRevision: 0, writeId: "native-write" },
    ),
  ).toMatchObject({ status: "persisted" });
  first.dispose();
  const saved = await readDurableComposerDraft(scope);
  expect(saved.status).toBe("found");
  if (saved.status !== "found") {
    throw new Error("Native draft was not restored");
  }
  const restored = createFileReferenceDestinationFixture(
    saved.draft.text,
    saved.draft.fileReferences,
  );
  onTestFinished(() => restored.dispose());
  expect(restored.destination.snapshot().references).toEqual([composerFileReferenceFixture]);
  expect(
    restored.input.parentElement!.querySelector(".chat-composer-file-reference")?.textContent,
  ).toBe("@src/example.ts");
  await retireDurableComposerDraft(scope, 2);
});

it("preserves future identity bytes through native reads, writes, conditional retirement and recovery", async () => {
  const scope = { ...owner, scopeKey: "chat:v3:agent:main:future\u0000agent:main" };
  const key = JSON.stringify([scope.gatewayOwner, scope.recoveryScope, scope.scopeKey]);
  const database = await openControlUiDatabase();
  // The previous binary opens version 2. Native IndexedDB must reject it before any read/write.
  await expect(requestResult(indexedDB.open("openclaw-control-ui", 2))).rejects.toMatchObject({
    name: "VersionError",
  });
  const future = {
    ...scope,
    key,
    ownerKey: JSON.stringify([scope.gatewayOwner, scope.recoveryScope]),
    revision: 2,
    text: "@src/example.ts",
    fileReferences: [
      {
        ...composerFileReferenceFixture,
        reference: {
          ...composerFileReferenceFixture.reference,
          schemaVersion: 2,
          futureIdentity: "keep",
        },
      },
    ],
    attachments: [],
    writeId: "future",
    updatedAt: Date.now(),
  };
  const transaction = database.transaction("composerDrafts", "readwrite");
  transaction.objectStore("composerDrafts").put(future);
  await transactionComplete(transaction);
  expect(await readDurableComposerDraft(scope)).toEqual({ status: "storage-failed" });
  expect(
    await writeDurableComposerDraft(
      scope,
      { revision: 3, text: "Replacement", attachments: [] },
      { expectedRevision: 2, writeId: "replacement" },
    ),
  ).toEqual({ status: "conflict" });
  expect(await retireDurableComposerDraft(scope, 3, 10)).toEqual({ status: "conflict" });
  const legacy = { ...owner, scopeKey: "global\u0000agent:main" };
  await writeDurableComposerDraft(
    legacy,
    { revision: 1, text: "Recover me", attachments: [] },
    { expectedRevision: 0, writeId: "legacy" },
  );
  expect(
    await restoreDurableComposerRecovery(
      scope,
      {
        owner,
        scopeKey: legacy.scopeKey,
        revision: 1,
        writeId: "legacy",
        updatedAt: Date.now(),
        text: "Recover me",
        attachmentNames: [],
      },
      2,
      "future",
      () => true,
      3,
    ),
  ).toEqual({ status: "conflict" });
  const read = database.transaction("composerDrafts", "readonly");
  expect(await requestResult(read.objectStore("composerDrafts").get(key))).toEqual(future);
  await transactionComplete(read);
  await retireDurableComposerDraft(scope, 3);
  await retireDurableComposerDraft(legacy, 3);
});
