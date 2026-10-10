/* @vitest-environment node */
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discardDurableComposerRecovery,
  listDurableChatDraftPresence,
  prepareDurableComposerRecovery,
  readDurableComposerDraft,
  retireDurableComposerDraft,
  subscribeDurableComposerDraftChanges,
  writeDurableComposerDraft,
} from "./composer-draft-store.runtime.ts";
import {
  openControlUiDatabase,
  requestResult,
  transactionComplete,
} from "./control-ui-database.runtime.ts";

const owner = { gatewayOwner: "ws://draft-presence.test", recoveryScope: "principal-a" };
const now = 1_800_000_000_000;
const chatKey = (name: string) => `agent:main:${name}\u0000agent:main`;
const scope = (name: string) => ({ ...owner, scopeKey: `chat:v3:${chatKey(name)}` });

function storedRecord(scopeKey: string, overrides: Record<string, unknown> = {}) {
  return {
    ...owner,
    key: JSON.stringify([owner.gatewayOwner, owner.recoveryScope, scopeKey]),
    ownerKey: JSON.stringify([owner.gatewayOwner, owner.recoveryScope]),
    scopeKey,
    revision: 10,
    text: "saved draft",
    attachments: [],
    updatedAt: now,
    writeId: "seed",
    ...overrides,
  };
}

async function seedRecords(records: unknown[]) {
  const database = await openControlUiDatabase();
  const transaction = database.transaction("composerDrafts", "readwrite");
  const store = transaction.objectStore("composerDrafts");
  for (const record of records) {
    store.put(record);
  }
  await transactionComplete(transaction);
  return database;
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(Date, "now").mockReturnValue(now);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  await requestResult(indexedDB.deleteDatabase("openclaw-control-ui"));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("durable recovery", () => {
  const legacyScope = { ...owner, scopeKey: "global\u0000agent:main" };
  async function recoveryEntry() {
    const result = await prepareDurableComposerRecovery(owner);
    if (result.status !== "ready" || result.entries.length !== 1) {
      throw new Error("Expected one recovery draft");
    }
    return result.entries[0]!;
  }

  it("preserves textless draft metadata and ignores clear fences without deleting them", async () => {
    const drafts = [
      {
        name: "attachment",
        attachments: [{ blob: new Blob(["saved"]), mimeType: "text/plain", fileName: "saved.txt" }],
      },
      { name: "goal", goalMode: { action: "start" } },
      { name: "reply", replyTarget: { messageId: "message", text: "quoted" } },
    ];
    await seedRecords([
      ...drafts.map(({ name, ...draft }) =>
        storedRecord("global\u0000agent:" + name, { text: "", ...draft }),
      ),
      storedRecord(legacyScope.scopeKey, { text: "" }),
    ]);
    const result = await prepareDurableComposerRecovery(owner);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("Recovery unavailable");
    }
    expect(result.entries).toHaveLength(3);
    expect(
      result.entries.every(
        (entry) =>
          entry.updatedAt === now &&
          entry.owner.gatewayOwner === owner.gatewayOwner &&
          entry.owner.recoveryScope === owner.recoveryScope,
      ),
    ).toBe(true);
    expect(result.entries.find((entry) => entry.attachmentNames.length)?.attachmentNames).toEqual([
      "saved.txt",
    ]);
    expect(result.entries.find((entry) => entry.goalMode)?.goalMode).toEqual({ action: "start" });
    expect(result.entries.find((entry) => entry.replyTarget)?.replyTarget).toEqual({
      messageId: "message",
      text: "quoted",
    });
    expect(await readDurableComposerDraft(legacyScope)).toEqual({
      status: "not-found",
      revision: 10,
      writeId: "seed",
    });
  });

  it("discards attachment bytes behind a higher clear fence and rejects stale writers", async () => {
    await seedRecords([
      storedRecord(legacyScope.scopeKey, {
        attachments: [{ blob: new Blob(["private bytes"]), mimeType: "text/plain" }],
      }),
    ]);
    const entry = await recoveryEntry();
    expect(await discardDurableComposerRecovery(owner, entry, () => true)).toEqual({
      status: "discarded",
    });
    expect(await prepareDurableComposerRecovery(owner)).toEqual({ status: "ready", entries: [] });
    const database = await openControlUiDatabase();
    const transaction = database.transaction("composerDrafts", "readonly");
    const record = await requestResult(
      transaction
        .objectStore("composerDrafts")
        .get(JSON.stringify([owner.gatewayOwner, owner.recoveryScope, legacyScope.scopeKey])),
    );
    await transactionComplete(transaction);
    expect(record).toMatchObject({ text: "", attachments: [] });
    expect(record.revision).toBeGreaterThan(entry.revision);
    expect(
      await writeDurableComposerDraft(
        legacyScope,
        { revision: 11, text: "stale draft", attachments: [] },
        { expectedRevision: 10, expectedWriteId: "seed", writeId: "stale" },
      ),
    ).toEqual({ status: "conflict" });
    expect(await discardDurableComposerRecovery(owner, entry, () => true)).toEqual({
      status: "conflict",
    });
  });

  it.each(["owner", "revision", "writeId", "current", "storage"] as const)(
    "preserves recovery when discard is blocked by %s",
    async (change) => {
      await seedRecords([
        storedRecord(
          legacyScope.scopeKey,
          change === "storage"
            ? { attachments: [{ blob: new Blob(["keep bytes"]), mimeType: "text/plain" }] }
            : {},
        ),
      ]);
      const entry = await recoveryEntry();
      if (change === "revision" || change === "writeId") {
        await seedRecords([
          storedRecord(
            legacyScope.scopeKey,
            change === "revision" ? { revision: 11 } : { writeId: "replacement" },
          ),
        ]);
      }
      const before = await readDurableComposerDraft(legacyScope);
      const write =
        change === "storage"
          ? vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
              throw new DOMException("blocked", "QuotaExceededError");
            })
          : undefined;
      let currentChecks = 0;
      expect(
        await discardDurableComposerRecovery(
          change === "owner" ? { ...owner, recoveryScope: "principal-b" } : owner,
          entry,
          () => change !== "current" || ++currentChecks === 1,
        ),
      ).toEqual({ status: change === "storage" ? "storage-failed" : "conflict" });
      write?.mockRestore();
      const retained = await readDurableComposerDraft(legacyScope);
      expect(retained).toEqual(before);
      if (change === "storage") {
        expect(retained.status).toBe("found");
        if (retained.status !== "found") {
          throw new Error("Missing retained draft");
        }
        expect(await retained.draft.attachments[0]!.blob.text()).toBe("keep bytes");
        expect(retained.draft.revision).toBe(entry.revision);
      }
    },
  );
});

describe("durable chat draft presence", () => {
  it("reports every chat draft kind and retirement fence for only the requested owner", async () => {
    const drafts = [
      { name: "text", text: "unsent", attachments: [] },
      {
        name: "attachment",
        text: "",
        attachments: [{ blob: new Blob(["attachment"]), mimeType: "text/plain" }],
      },
      { name: "goal", text: "", attachments: [], goalMode: { action: "start" as const } },
      {
        name: "reply",
        text: "",
        attachments: [],
        replyTarget: { messageId: "message-1", text: "quoted message" },
      },
    ];
    for (const draft of drafts) {
      expect(
        await writeDurableComposerDraft(
          scope(draft.name),
          { ...draft, revision: 10 },
          { expectedRevision: 0, writeId: draft.name },
        ),
      ).toMatchObject({ status: "persisted" });
    }
    const retired = await retireDurableComposerDraft(scope("retired"), 10);
    expect(retired.status).toBe("persisted");
    if (retired.status !== "persisted") {
      throw new Error("Draft retirement failed");
    }
    await seedRecords([
      storedRecord(scope("other-owner").scopeKey, {
        ownerKey: JSON.stringify([owner.gatewayOwner, "principal-b"]),
        recoveryScope: "principal-b",
      }),
      storedRecord(scope("wrong-gateway").scopeKey, { gatewayOwner: "ws://other.test" }),
      storedRecord(scope("wrong-principal").scopeKey, { recoveryScope: "principal-b" }),
      storedRecord(`questions:v1:${scope("questions").scopeKey}`),
      storedRecord(chatKey("legacy")),
      storedRecord("new-session"),
      storedRecord(scope("invalid").scopeKey, { revision: -1 }),
    ]);

    expect(await listDurableChatDraftPresence(owner)).toEqual({
      status: "ready",
      presence: new Map([
        ...drafts.map(({ name }) => [chatKey(name), { revision: 10, active: true }] as const),
        [chatKey("retired"), { revision: retired.revision, active: false }],
      ]),
    });
  });

  it("projects expired drafts as pending clears without writing or reading Blob bytes", async () => {
    const expired = storedRecord(scope("expired").scopeKey, {
      updatedAt: now - 8 * 24 * 60 * 60 * 1_000,
      attachments: [{ blob: new Blob(["keep these bytes"]), mimeType: "text/plain" }],
    });
    const database = await seedRecords([expired]);
    const transactions = vi.spyOn(database, "transaction");
    const blobText = vi.spyOn(Blob.prototype, "text");
    const blobBytes = vi.spyOn(Blob.prototype, "arrayBuffer");
    const listener = vi.fn();
    const unsubscribe = subscribeDurableComposerDraftChanges(listener);
    try {
      expect(await listDurableChatDraftPresence(owner)).toEqual({
        status: "ready",
        presence: new Map([
          [chatKey("expired"), { revision: Number.MAX_SAFE_INTEGER, active: false }],
        ]),
      });
      expect(transactions).toHaveBeenCalledExactlyOnceWith("composerDrafts", "readonly");
      expect(blobText).not.toHaveBeenCalled();
      expect(blobBytes).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      const transaction = database.transaction("composerDrafts", "readonly");
      const stored = await requestResult(
        transaction.objectStore("composerDrafts").get(expired.key),
      );
      await transactionComplete(transaction);
      expect(stored).toEqual(expired);
    } finally {
      unsubscribe();
    }
  });

  it("notifies after write and retirement commit, but not after presence reads", async () => {
    const database = await openControlUiDatabase();
    const transaction = database.transaction.bind(database);
    let committed = false;
    vi.spyOn(database, "transaction").mockImplementation((...args) => {
      const current = transaction(...args);
      if (current.mode === "readwrite") {
        committed = false;
        current.addEventListener("complete", () => {
          committed = true;
        });
      }
      return current;
    });
    const notifications: boolean[] = [];
    const unsubscribe = subscribeDurableComposerDraftChanges(() => notifications.push(committed));
    try {
      await writeDurableComposerDraft(
        scope("notified"),
        { text: "unsent", attachments: [], revision: 10 },
        { expectedRevision: 0, writeId: "write" },
      );
      expect(notifications).toEqual([true]);
      await listDurableChatDraftPresence(owner);
      expect(notifications).toEqual([true]);
      await retireDurableComposerDraft(scope("notified"));
      expect(notifications).toEqual([true, true]);
    } finally {
      unsubscribe();
    }
    await retireDurableComposerDraft(scope("notified"));
    expect(notifications).toEqual([true, true]);
  });
});
