/* @vitest-environment node */
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import * as drafts from "./composer-draft-store.runtime.ts";
import {
  openControlUiDatabase,
  requestResult,
  transactionComplete,
} from "./control-ui-database.runtime.ts";
import type { StoredComposerSession } from "./outbox-store-codec.ts";
import { createStoredChatOutboxReader } from "./outbox-store-projection.ts";
import {
  storedChatOutboxScopeKey,
  storageTargetForComposer,
  subscribeStoredChatOutboxChanges,
  writeStoredOutboxStore,
} from "./outbox-store.ts";

const gatewayUrl = "ws://draft-projection.test";
const owner = { gatewayOwner: gatewayUrl, recoveryScope: "principal-a" };
const state = () => ({
  settings: { gatewayUrl },
  connected: true,
  client: { recoveryScope: owner.recoveryScope, recoveryScopeReady: true },
});
const key = (name: string) => `agent:main:${name}`;
const storedKey = (name: string) => storedChatOutboxScopeKey({ sessionKey: key(name) });
const scope = (name: string) => ({ ...owner, scopeKey: `chat:v3:${storedKey(name)}` });
const cleanups: (() => void)[] = [];
const unsubscribeAll = () => cleanups.splice(0).forEach((cleanup) => cleanup());

function projection() {
  const reader = createStoredChatOutboxReader();
  const changes = subscribe(reader);
  const host = state();
  const list = vi.spyOn(drafts, "listDurableChatDraftPresence");
  const read = () => reader.read(host);
  const has = (name: string) => read().hasSessionDraft(key(name));
  const silentLoad = async (count: number, summary: ReturnType<typeof read>) => {
    expect(list).toHaveBeenCalledTimes(count);
    await list.mock.results[count - 1]?.value;
    expect(changes.listener).not.toHaveBeenCalled();
    expect(read()).toBe(summary);
  };
  const write = async (name: string) => {
    const changed = changes.next();
    await writeDraft(name);
    await changed;
  };
  const load = async () => {
    read();
    await changes.changed;
    return read();
  };
  return { reader, changes, host, list, read, has, write, silentLoad, load };
}

function expectDrafts(
  summary: ReturnType<ReturnType<typeof createStoredChatOutboxReader>["read"]>,
  expected: Record<string, boolean>,
) {
  const actual = Object.keys(expected).map((name) => [name, summary.hasSessionDraft(key(name))]);
  expect(Object.fromEntries(actual)).toEqual(expected);
}

function subscribe(reader: ReturnType<typeof createStoredChatOutboxReader>) {
  let change = Promise.withResolvers<void>();
  const listener = vi.fn(() => change.resolve());
  cleanups.push(reader.subscribe(listener));
  return {
    listener,
    next() {
      change = Promise.withResolvers<void>();
      return change.promise;
    },
    get changed() {
      return change.promise;
    },
  };
}

function seedTab(rows: Record<string, Omit<StoredComposerSession, "updatedAt">>) {
  writeStoredOutboxStore(sessionStorage, storageTargetForComposer(state()), {
    version: 4,
    gatewayOwner: gatewayUrl,
    recovery: {},
    sessions: Object.fromEntries(
      Object.entries(rows).map(([name, row]) => [storedKey(name), { updatedAt: 1, ...row }]),
    ),
  });
}

const attachments = [{ blob: new Blob(["attachment"]), mimeType: "text/plain" }];
async function writeDraft(
  name: string,
  input: Partial<drafts.DurableComposerDraft> = { attachments },
) {
  expect(
    await drafts.writeDurableComposerDraft(
      scope(name),
      { revision: 10, text: "", attachments: [], ...input },
      { expectedRevision: 0, writeId: name },
    ),
  ).toMatchObject({ status: "persisted" });
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  unsubscribeAll();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  await requestResult(indexedDB.deleteDatabase("openclaw-control-ui"));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retires a cached tab summary when the same offline client loses local admission", () => {
  seedTab({ a: { draft: "offline input", draftRevision: 10 } });
  const host = {
    ...state(),
    connected: false,
    client: {
      recoveryScope: "",
      recoveryScopeReady: false,
      offlineRecoveryScope: owner.recoveryScope,
    },
  };
  const reader = createStoredChatOutboxReader();
  expect(reader.read(host).hasSessionDraft(key("a"))).toBe(true);
  host.client.offlineRecoveryScope = "";
  expect(reader.read(host).hasSessionDraft(key("a"))).toBe(false);
});

it.each(["read", "sweep"])("expires attachment-only badges via %s", async (path) => {
  const now = 1_800_000_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await writeDraft("expired");
  const p = projection();
  await p.load();
  expect(p.has("expired")).toBe(true);
  p.changes.listener.mockClear();

  clock.mockReturnValue(now + 7 * 24 * 60 * 60 * 1_000 + 1);
  if (path === "read") {
    expect(await drafts.readDurableComposerDraft(scope("expired"))).toMatchObject({
      status: "not-found",
    });
  } else {
    await vi.runOnlyPendingTimersAsync();
    // Queue a read behind the sweep transaction before checking its invalidation.
    await drafts.listDurableChatDraftPresence(owner);
  }
  await Promise.all(p.list.mock.results.map(({ value }) => value));
  expect(p.has("expired")).toBe(false);
  expect(p.changes.listener).toHaveBeenCalledOnce();
});

it.each(["unchanged", "unavailable"])("keeps %s loads silent", async (initialLoad) => {
  if (initialLoad === "unchanged") {
    seedTab({ a: { draft: "tab input", draftRevision: 10 } });
  }
  const p = projection();
  if (initialLoad === "unavailable") {
    p.list.mockResolvedValueOnce({ status: "storage-failed" });
  }
  const initial = p.read();
  await vi.dynamicImportSettled();
  await p.silentLoad(1, initial);
  expect(initial.hasSessionDraft(key("a"))).toBe(initialLoad === "unchanged");

  if (initialLoad === "unchanged") {
    await writeDraft("a");
    await p.silentLoad(2, initial);
  }
  await p.write("b");
  const summary = p.read();
  expect(p.changes.listener).toHaveBeenCalledOnce();
  expect(summary).not.toBe(initial);
  expect(summary.hasSessionDraft(key("b"))).toBe(true);
  if (initialLoad === "unchanged") {
    expect(summary.hasSessionDraft(key("a"))).toBe(true);
  } else {
    unsubscribeAll();
    await writeDraft("c");
    expect(p.list).toHaveBeenCalledTimes(2);
    const reattached = subscribe(p.reader);
    await reattached.changed;
    expect(p.has("c")).toBe(true);
  }
});

it.each(["loaded", "pending"])("drops replaced owners' %s drafts", async (phase) => {
  const pending =
    Promise.withResolvers<Awaited<ReturnType<typeof drafts.listDurableChatDraftPresence>>>();
  const started = Promise.withResolvers<void>();
  if (phase === "loaded") {
    await writeDraft("b");
  }
  const p = projection();
  if (phase === "pending") {
    p.list
      .mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      })
      .mockResolvedValue({ status: "ready", presence: new Map() });
  }
  const globalListener = vi.fn();
  cleanups.push(subscribeStoredChatOutboxChanges(globalListener));
  expect(p.has("b")).toBe(false);
  if (phase === "pending") {
    await started.promise;
  } else {
    await p.changes.changed;
    expect(p.has("b")).toBe(true);
    expect(globalListener).not.toHaveBeenCalled();
  }
  p.changes.listener.mockClear();
  p.host.client = { recoveryScope: "principal-b", recoveryScopeReady: true };
  expect(p.has("b")).toBe(false);
  if (phase === "pending") {
    pending.resolve({
      status: "ready",
      presence: new Map([[storedKey("b"), { revision: 10, active: true }]]),
    });
    await pending.promise;
  }
  await p.list.mock.results.at(-1)?.value;
  expect(p.changes.listener).not.toHaveBeenCalled();
  expect(p.has("b")).toBe(false);
  expect(p.read().sessions).toEqual([]);
});

it("merges revision fences and all tab input kinds while excluding Incognito keys", async () => {
  await writeDraft("tab-cleared");
  await writeDraft("durable-retired");
  await writeDraft("dashboard:incognito-durable");
  await drafts.retireDurableComposerDraft(scope("durable-retired"), 10);
  seedTab({
    "tab-cleared": { draftRevision: 11 },
    "durable-retired": { draft: "old tab input", draftRevision: 10 },
    goal: { goalMode: { action: "start" } },
    reply: { replyTarget: { messageId: "message-1", text: "quoted" } },
    "dashboard:incognito-tab": { draft: "private" },
  });
  const p = projection();
  expectDrafts(p.read(), { goal: true, reply: true });
  await p.changes.changed;
  const summary = p.read();
  expectDrafts(summary, {
    "tab-cleared": false,
    "durable-retired": false,
    "dashboard:incognito-durable": false,
    "dashboard:incognito-tab": false,
  });
  expect(summary.sessions.map(({ sessionKey }) => sessionKey)).toEqual(["goal", "reply"].map(key));
});

it("does not open IndexedDB without subscribers or a ready recovery owner", async () => {
  const open = vi.spyOn(indexedDB, "open");
  const list = vi.spyOn(drafts, "listDurableChatDraftPresence");
  const reader = createStoredChatOutboxReader();
  reader.read(state());
  const other = createStoredChatOutboxReader();
  subscribe(other);
  other.read({ ...state(), client: null });
  other.read({ ...state(), client: { recoveryScope: "pending", recoveryScopeReady: false } });
  await vi.dynamicImportSettled();
  expect(open).not.toHaveBeenCalled();
  const attached = subscribe(reader);
  await vi.dynamicImportSettled();
  expect(list).toHaveBeenCalledOnce();
  await list.mock.results[0]?.value;
  expect(attached.listener).not.toHaveBeenCalled();
});

it.each(["storage-failed", "exception"])("deduplicates %s fallbacks", async (failure) => {
  await writeDraft("b");
  const p = projection();
  const initial = await p.load();
  expect(initial.hasSessionDraft(key("b"))).toBe(true);
  if (failure === "storage-failed") {
    p.list.mockResolvedValue({ status: "storage-failed" });
  } else {
    p.list.mockRejectedValue(new Error("Presence load failed"));
  }
  p.changes.listener.mockClear();
  await p.write("c");
  const fallback = p.read();
  expect(p.changes.listener).toHaveBeenCalledOnce();
  expect(fallback).not.toBe(initial);
  expectDrafts(fallback, { b: false, c: false });

  p.changes.listener.mockClear();
  await writeDraft("d");
  await p.list.mock.results[2]?.value.catch(() => undefined);
  expect(p.changes.listener).not.toHaveBeenCalled();
  expect(p.read()).toBe(fallback);
});

const now = 1_800_000_000_000;
const legacyScope = { ...owner, scopeKey: "global\u0000agent:main" };
const attachment = (text: string, fileName?: string) => ({
  blob: new Blob([text]),
  mimeType: "text/plain",
  ...(fileName ? { fileName } : {}),
});
const textlessDrafts = [
  { name: "attachment", attachments: [attachment("saved", "saved.txt")] },
  { name: "goal", goalMode: { action: "start" as const } },
  { name: "reply", replyTarget: { messageId: "message", text: "quoted" } },
];

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

async function seedRecords(...records: unknown[]) {
  const database = await openControlUiDatabase();
  const transaction = database.transaction("composerDrafts", "readwrite");
  const store = transaction.objectStore("composerDrafts");
  for (const record of records) {
    store.put(record);
  }
  await transactionComplete(transaction);
  return database;
}

async function readStoredRecord(recordKey: string) {
  const database = await openControlUiDatabase();
  const transaction = database.transaction("composerDrafts", "readonly");
  const record = await requestResult(transaction.objectStore("composerDrafts").get(recordKey));
  await transactionComplete(transaction);
  return record;
}

describe("durable draft records", () => {
  beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));

  describe("durable recovery", () => {
    const legacyRecord = (overrides: Record<string, unknown> = {}) =>
      storedRecord(legacyScope.scopeKey, overrides);
    async function recoveryEntries(count: number) {
      const result = await drafts.prepareDurableComposerRecovery(owner);
      assert(result.status === "ready", "Recovery unavailable");
      expect(result.entries).toHaveLength(count);
      return result.entries;
    }
    const discard = (entry: drafts.DurableComposerRecoveryEntry) =>
      drafts.discardDurableComposerRecovery(owner, entry, () => true);
    it("preserves textless draft metadata and ignores clear fences without deleting them", async () => {
      await seedRecords(
        ...textlessDrafts.map(({ name, ...draft }) =>
          storedRecord("global\u0000agent:" + name, { text: "", ...draft }),
        ),
        legacyRecord({ text: "" }),
      );
      const entries = await recoveryEntries(3);
      for (const entry of entries) {
        expect(entry).toMatchObject({ updatedAt: now, owner });
      }
      expect(entries.find((entry) => entry.attachmentNames.length)?.attachmentNames).toEqual([
        "saved.txt",
      ]);
      expect(entries.find((entry) => entry.goalMode)?.goalMode).toEqual({ action: "start" });
      expect(entries.find((entry) => entry.replyTarget)?.replyTarget).toEqual({
        messageId: "message",
        text: "quoted",
      });
      expect(await drafts.readDurableComposerDraft(legacyScope)).toEqual({
        status: "not-found",
        revision: 10,
        writeId: "seed",
      });
    });

    it("discards attachment bytes behind a higher clear fence and rejects stale writers", async () => {
      await seedRecords(legacyRecord({ attachments: [attachment("private bytes")] }));
      const entry = (await recoveryEntries(1))[0]!;
      expect(await discard(entry)).toEqual({ status: "discarded" });
      expect(await drafts.prepareDurableComposerRecovery(owner)).toEqual({
        status: "ready",
        entries: [],
      });
      const record = await readStoredRecord(legacyRecord().key);
      expect(record).toMatchObject({ text: "", attachments: [] });
      expect(record.revision).toBeGreaterThan(entry.revision);
      expect(
        await drafts.writeDurableComposerDraft(
          legacyScope,
          { revision: 11, text: "stale draft", attachments: [] },
          { expectedRevision: 10, expectedWriteId: "seed", writeId: "stale" },
        ),
      ).toEqual({ status: "conflict" });
      expect(await discard(entry)).toEqual({ status: "conflict" });
    });

    it.each(["owner", "revision", "writeId", "current", "storage"] as const)(
      "preserves recovery when discard is blocked by %s",
      async (change) => {
        await seedRecords(
          legacyRecord(change === "storage" ? { attachments: [attachment("keep bytes")] } : {}),
        );
        const entry = (await recoveryEntries(1))[0]!;
        if (change === "revision" || change === "writeId") {
          await seedRecords(
            legacyRecord(change === "revision" ? { revision: 11 } : { writeId: "replacement" }),
          );
        }
        const before = await drafts.readDurableComposerDraft(legacyScope);
        const write =
          change === "storage"
            ? vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
                throw new DOMException("blocked", "QuotaExceededError");
              })
            : undefined;
        let currentChecks = 0;
        expect(
          await drafts.discardDurableComposerRecovery(
            change === "owner" ? { ...owner, recoveryScope: "principal-b" } : owner,
            entry,
            () => change !== "current" || ++currentChecks === 1,
          ),
        ).toEqual({ status: change === "storage" ? "storage-failed" : "conflict" });
        write?.mockRestore();
        const retained = await drafts.readDurableComposerDraft(legacyScope);
        expect(retained).toEqual(before);
        if (change === "storage") {
          assert(retained.status === "found", "Missing retained draft");
          expect(await retained.draft.attachments[0]!.blob.text()).toBe("keep bytes");
          expect(retained.draft.revision).toBe(entry.revision);
        }
      },
    );
  });

  describe("durable chat draft presence", () => {
    it("reports every chat draft kind and retirement fence for only the requested owner", async () => {
      const draftInputs = [
        { name: "text", text: "unsent", attachments: [] },
        ...textlessDrafts.map((draft) => Object.assign({ text: "", attachments: [] }, draft)),
      ];
      for (const { name, ...draft } of draftInputs) {
        await writeDraft(name, draft);
      }
      const retired = await drafts.retireDurableComposerDraft(scope("retired"), 10);
      assert(retired.status === "persisted", "Draft retirement failed");
      await seedRecords(
        storedRecord(scope("other-owner").scopeKey, {
          ownerKey: JSON.stringify([owner.gatewayOwner, "principal-b"]),
          recoveryScope: "principal-b",
        }),
        storedRecord(scope("wrong-gateway").scopeKey, { gatewayOwner: "ws://other.test" }),
        storedRecord(scope("wrong-principal").scopeKey, { recoveryScope: "principal-b" }),
        storedRecord(`questions:v1:${scope("questions").scopeKey}`),
        storedRecord(storedKey("legacy")),
        storedRecord("new-session"),
        storedRecord(scope("invalid").scopeKey, { revision: -1 }),
      );

      expect(await drafts.listDurableChatDraftPresence(owner)).toEqual({
        status: "ready",
        presence: new Map([
          ...draftInputs.map(
            ({ name }) => [storedKey(name), { revision: 10, active: true }] as const,
          ),
          [storedKey("retired"), { revision: retired.revision, active: false }],
        ]),
      });
    });

    it("projects expired drafts as pending clears without writing or reading Blob bytes", async () => {
      const expired = storedRecord(scope("expired").scopeKey, {
        updatedAt: now - 8 * 24 * 60 * 60 * 1_000,
        attachments: [attachment("keep these bytes")],
      });
      await seedRecords(expired);
      const blobText = vi.spyOn(Blob.prototype, "text");
      const blobBytes = vi.spyOn(Blob.prototype, "arrayBuffer");
      const listener = vi.fn();
      cleanups.push(drafts.subscribeDurableComposerDraftChanges(listener));
      expect(await drafts.listDurableChatDraftPresence(owner)).toEqual({
        status: "ready",
        presence: new Map([
          [storedKey("expired"), { revision: Number.MAX_SAFE_INTEGER, active: false }],
        ]),
      });
      expect(blobText).not.toHaveBeenCalled();
      expect(blobBytes).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(await readStoredRecord(expired.key)).toEqual(expired);
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
      const unsubscribe = drafts.subscribeDurableComposerDraftChanges(() =>
        notifications.push(committed),
      );
      cleanups.push(unsubscribe);
      await writeDraft("notified", { text: "unsent" });
      expect(notifications).toEqual([true]);
      await drafts.listDurableChatDraftPresence(owner);
      expect(notifications).toEqual([true]);
      await drafts.retireDurableComposerDraft(scope("notified"));
      expect(notifications).toEqual([true, true]);
      unsubscribe();
      await drafts.retireDurableComposerDraft(scope("notified"));
      expect(notifications).toEqual([true, true]);
    });
  });
});
