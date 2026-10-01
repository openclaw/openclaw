/* @vitest-environment node */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listDurableChatDraftPresence,
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
