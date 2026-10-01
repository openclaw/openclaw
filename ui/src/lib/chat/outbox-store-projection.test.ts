/* @vitest-environment node */
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import * as drafts from "./composer-draft-store.runtime.ts";
import { requestResult } from "./control-ui-database.runtime.ts";
import type { StoredComposerSession } from "./outbox-store-codec.ts";
import { createStoredChatOutboxReader } from "./outbox-store-projection.ts";
import {
  storedChatOutboxScopeKey,
  storageTargetForGateway,
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

function seedTab(rows: Record<string, StoredComposerSession>) {
  writeStoredOutboxStore(sessionStorage, storageTargetForGateway(gatewayUrl), {
    version: 4,
    gatewayOwner: gatewayUrl,
    recovery: {},
    sessions: Object.fromEntries(Object.entries(rows).map(([name, row]) => [storedKey(name), row])),
  });
}

async function writeDraft(name: string, revision = 10) {
  expect(
    await drafts.writeDurableComposerDraft(
      scope(name),
      {
        revision,
        text: "",
        attachments: [{ blob: new Blob(["attachment"]), mimeType: "text/plain" }],
      },
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
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.clearAllTimers();
  await requestResult(indexedDB.deleteDatabase("openclaw-control-ui"));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("stored draft projection", () => {
  it.each(["read", "sweep"])(
    "clears a cached attachment-only draft badge after expiry through %s",
    async (path) => {
      const now = 1_800_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      await writeDraft("expired");
      const list = vi.spyOn(drafts, "listDurableChatDraftPresence");
      const reader = createStoredChatOutboxReader();
      const changes = subscribe(reader);
      const host = state();
      reader.read(host);
      await changes.changed;
      expect(reader.read(host).hasSessionDraft(key("expired"))).toBe(true);
      changes.listener.mockClear();

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
      await Promise.all(list.mock.results.map(({ value }) => value));
      expect(reader.read(host).hasSessionDraft(key("expired"))).toBe(false);
      expect(changes.listener).toHaveBeenCalledOnce();
    },
  );

  it("preserves the summary and stays silent when a durable write leaves badges unchanged", async () => {
    seedTab({ a: { draft: "tab input", draftRevision: 10, updatedAt: 1 } });
    const list = vi.spyOn(drafts, "listDurableChatDraftPresence");
    const reader = createStoredChatOutboxReader();
    const changes = subscribe(reader);
    const host = state();
    reader.read(host);
    await vi.dynamicImportSettled();
    expect(list).toHaveBeenCalledTimes(1);
    await list.mock.results[0]?.value;
    const initial = reader.read(host);
    expect(initial.hasSessionDraft(key("a"))).toBe(true);
    changes.listener.mockClear();

    await writeDraft("a");
    expect(list).toHaveBeenCalledTimes(2);
    await list.mock.results[1]?.value;
    expect(changes.listener).not.toHaveBeenCalled();
    expect(reader.read(host)).toBe(initial);

    const changed = changes.next();
    await writeDraft("b");
    await changed;
    const summary = reader.read(host);
    expect(changes.listener).toHaveBeenCalledOnce();
    expect(summary).not.toBe(initial);
    expect(summary.hasSessionDraft(key("a"))).toBe(true);
    expect(summary.hasSessionDraft(key("b"))).toBe(true);
  });

  it("loads unopened attachment drafts, reloads local writes, and drops a replaced owner", async () => {
    await writeDraft("b");
    const list = vi.spyOn(drafts, "listDurableChatDraftPresence");
    const reader = createStoredChatOutboxReader();
    const changes = subscribe(reader);
    const globalListener = vi.fn();
    cleanups.push(subscribeStoredChatOutboxChanges(globalListener));
    const host = state();
    expect(reader.read(host).hasSessionDraft(key("b"))).toBe(false);
    await changes.changed;
    expect(reader.read(host).hasSessionDraft(key("b"))).toBe(true);
    expect(globalListener).not.toHaveBeenCalled();

    const written = changes.next();
    await writeDraft("c");
    await written;
    expect(reader.read(host).hasSessionDraft(key("c"))).toBe(true);

    changes.listener.mockClear();
    host.client = { recoveryScope: "principal-b", recoveryScopeReady: true };
    expect(reader.read(host).hasSessionDraft(key("b"))).toBe(false);
    expect(list).toHaveBeenCalledTimes(3);
    await list.mock.results[2]?.value;
    expect(changes.listener).not.toHaveBeenCalled();
    expect(reader.read(host).hasSessionDraft(key("c"))).toBe(false);
  });

  it("merges revision fences and all tab input kinds while excluding Incognito keys", async () => {
    await writeDraft("tab-cleared");
    await writeDraft("durable-retired");
    await writeDraft("dashboard:incognito-durable");
    await drafts.retireDurableComposerDraft(scope("durable-retired"), 10);
    seedTab({
      "tab-cleared": { draftRevision: 11, updatedAt: 1 },
      "durable-retired": { draft: "old tab input", draftRevision: 10, updatedAt: 1 },
      goal: { goalMode: { action: "start" }, updatedAt: 1 },
      reply: { replyTarget: { messageId: "message-1", text: "quoted" }, updatedAt: 1 },
      "dashboard:incognito-tab": { draft: "private", updatedAt: 1 },
    });
    const reader = createStoredChatOutboxReader();
    const changes = subscribe(reader);
    const host = state();
    const initial = reader.read(host);
    expect(initial.hasSessionDraft(key("goal"))).toBe(true);
    expect(initial.hasSessionDraft(key("reply"))).toBe(true);
    await changes.changed;
    const summary = reader.read(host);
    for (const name of [
      "tab-cleared",
      "durable-retired",
      "dashboard:incognito-durable",
      "dashboard:incognito-tab",
    ]) {
      expect(summary.hasSessionDraft(key(name)), name).toBe(false);
    }
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

  it("discards an old owner's in-flight result and serializes its replacement", async () => {
    const pending =
      Promise.withResolvers<Awaited<ReturnType<typeof drafts.listDurableChatDraftPresence>>>();
    const started = Promise.withResolvers<void>();
    const list = vi
      .spyOn(drafts, "listDurableChatDraftPresence")
      .mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      })
      .mockResolvedValue({ status: "ready", presence: new Map() });
    const reader = createStoredChatOutboxReader();
    const changes = subscribe(reader);
    const host = state();
    reader.read(host);
    await started.promise;
    host.client = { recoveryScope: "principal-b", recoveryScopeReady: true };
    reader.read(host);
    expect(list).toHaveBeenCalledTimes(1);
    pending.resolve({
      status: "ready",
      presence: new Map([[storedKey("b"), { revision: 10, active: true }]]),
    });
    await pending.promise;
    expect(list).toHaveBeenCalledTimes(2);
    await list.mock.results[1]?.value;
    expect(changes.listener).not.toHaveBeenCalled();
    expect(reader.read(host).hasSessionDraft(key("b"))).toBe(false);
  });

  it("keeps storage failure tab-only until a change and releases its durable subscription", async () => {
    const list = vi
      .spyOn(drafts, "listDurableChatDraftPresence")
      .mockResolvedValueOnce({ status: "storage-failed" });
    const reader = createStoredChatOutboxReader();
    const changes = subscribe(reader);
    const host = state();
    const initial = reader.read(host);
    await vi.dynamicImportSettled();
    expect(list).toHaveBeenCalledTimes(1);
    await list.mock.results[0]?.value;
    expect(changes.listener).not.toHaveBeenCalled();
    expect(reader.read(host)).toBe(initial);
    const changed = changes.next();
    await writeDraft("b");
    await changed;
    expect(reader.read(host).hasSessionDraft(key("b"))).toBe(true);
    cleanups.splice(0).forEach((cleanup) => cleanup());
    await writeDraft("c");
    expect(list).toHaveBeenCalledTimes(2);
    const reattached = subscribe(reader);
    await reattached.changed;
    expect(reader.read(host).hasSessionDraft(key("c"))).toBe(true);
  });

  it.each(["storage-failed", "exception"] as const)(
    "notifies on %s only when tab-only fallback changes a badge",
    async (failure) => {
      await writeDraft("b");
      const list = vi.spyOn(drafts, "listDurableChatDraftPresence");
      const reader = createStoredChatOutboxReader();
      const changes = subscribe(reader);
      const host = state();
      reader.read(host);
      await changes.changed;
      const initial = reader.read(host);
      expect(initial.hasSessionDraft(key("b"))).toBe(true);
      if (failure === "storage-failed") {
        list.mockResolvedValue({ status: "storage-failed" });
      } else {
        list.mockRejectedValue(new Error("Presence load failed"));
      }
      changes.listener.mockClear();
      const changed = changes.next();
      await writeDraft("c");
      await changed;
      const fallback = reader.read(host);
      expect(changes.listener).toHaveBeenCalledOnce();
      expect(fallback).not.toBe(initial);
      expect(fallback.hasSessionDraft(key("b"))).toBe(false);
      expect(fallback.hasSessionDraft(key("c"))).toBe(false);

      changes.listener.mockClear();
      await writeDraft("d");
      expect(list).toHaveBeenCalledTimes(3);
      await list.mock.results[2]?.value.catch(() => undefined);
      expect(changes.listener).not.toHaveBeenCalled();
      expect(reader.read(host)).toBe(fallback);
    },
  );
});
