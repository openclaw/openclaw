/* @vitest-environment node */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import * as drafts from "./composer-draft-store.runtime.ts";
import { requestResult } from "./control-ui-database.runtime.ts";
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
const badge = (name: string) => ({
  agentId: "main",
  sessionKey: key(name),
  hasComposerDraft: true,
  outboxAttentionCount: 0,
});

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
  return { reader, changes, host, list, read, has, write, silentLoad };
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
async function writeDraft(name: string) {
  const result = await drafts.writeDurableComposerDraft(
    scope(name),
    { revision: 10, text: "", attachments },
    { expectedRevision: 0, writeId: name },
  );
  expect(result).toMatchObject({ status: "persisted" });
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
  p.read();
  await p.changes.changed;
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
    expect(p.read().sessions).toEqual([badge("b")]);
    expect(globalListener).not.toHaveBeenCalled();
    await p.write("c");
    expect(p.has("c")).toBe(true);
  }
  p.changes.listener.mockClear();
  p.host.client = { recoveryScope: "principal-b", recoveryScopeReady: true };
  expect(p.has("b")).toBe(false);
  expect(p.list).toHaveBeenCalledTimes(phase === "pending" ? 1 : 3);
  if (phase === "pending") {
    pending.resolve({
      status: "ready",
      presence: new Map([[storedKey("b"), { revision: 10, active: true }]]),
    });
    await pending.promise;
    expect(p.list).toHaveBeenCalledTimes(2);
  }
  await p.list.mock.results.at(-1)?.value;
  expect(p.changes.listener).not.toHaveBeenCalled();
  expectDrafts(p.read(), { b: false, c: false });
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
  expect(summary.sessions).toEqual(["goal", "reply"].map(badge));
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
  expect(open).toHaveBeenCalledOnce();
});

it.each(["storage-failed", "exception"])("deduplicates %s fallbacks", async (failure) => {
  await writeDraft("b");
  const p = projection();
  p.read();
  await p.changes.changed;
  const initial = p.read();
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
  expect(p.list).toHaveBeenCalledTimes(3);
  await p.list.mock.results[2]?.value.catch(() => undefined);
  expect(p.changes.listener).not.toHaveBeenCalled();
  expect(p.read()).toBe(fallback);
});
