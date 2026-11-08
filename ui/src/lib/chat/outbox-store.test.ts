/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import * as payloadStore from "./outbox-payload-store.runtime.ts";
import { outboxStorageScope } from "./outbox-payload-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  discardChatOutboxRecovery,
  readChatOutboxRecovery,
  retireDeliveredChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "./outbox-recovery.ts";
import type {
  StoredComposerRecovery,
  StoredComposerSession,
  StoredComposerState,
} from "./outbox-store-codec.ts";
import { createStoredChatOutboxReader } from "./outbox-store-projection.ts";
import { retireStoredComposerDrafts } from "./outbox-store-retirement.ts";
import {
  readProjectedOutboxStore,
  readStoredOutboxStore,
  storedChatOutboxScopeKey,
  storageTargetForComposer,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
  writeStoredOutboxStore,
} from "./outbox-store.ts";
import {
  draftSession,
  privateInput,
  queued,
  recoveryRow,
  recoveryRows,
  seedSource,
  seedStore,
  sourceJson,
  storedSession,
} from "./outbox.test-support.ts";

function ownedState(gatewayUrl = target.gatewayOwner) {
  return {
    settings: { gatewayUrl },
    client: { recoveryScope: "summary-owner", recoveryScopeReady: true },
    connected: true,
  };
}

function ownedQueue(gatewayUrl: string, queue: ChatQueueItem[]): ChatQueueItem[] {
  return queue.map((item) => ({
    ...item,
    storageScope: outboxStorageScope(ownedState(gatewayUrl)),
  }));
}

const readStore = () => readStoredOutboxStore(sessionStorage, target);
const queueItems = (store: StoredComposerState) =>
  Object.values(store.sessions).flatMap((entry) => entry.queue ?? []);
const storedJson = (key: string) => JSON.parse(sessionStorage.getItem(key)!);

const mention = (start = 0, end = 5) => ({ profileId: "profile-alex", start, end });
function storageEvent(key: string | null) {
  const event = new StorageEvent("storage", { key });
  Object.defineProperty(event, "storageArea", { value: sessionStorage });
  window.dispatchEvent(event);
}

const badge = (
  sessionKey: string,
  agentId: string | undefined,
  hasComposerDraft: boolean,
  outboxAttentionCount = 0,
) => ({ agentId, sessionKey, hasComposerDraft, outboxAttentionCount });
const gatewayUrl = "ws://gateway.test/control";
const target = storageTargetForGateway(gatewayUrl);
const privateScope = "agent:main:dashboard:incognito-test\u0000agent:main";
const quotaExceeded = () => {
  throw new DOMException("quota exceeded", "QuotaExceededError");
};
const cleanups: Array<() => void> = [];
beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["raw", "cleared"])("preserves newer legacy bytes during %s retirement", (input) => {
  const source = (id: string) =>
    sourceJson(target, 3, {
      [privateScope]: storedSession({ draft: "Private legacy input", queue: [queued(id)] }),
    });
  sessionStorage.setItem(target.blobKey, source("submitted"));
  if (input === "cleared") {
    const removal = vi.spyOn(sessionStorage, "removeItem").mockImplementation(() => {});
    readStore();
    expect(sessionStorage.getItem(target.blobKey)).toBe("");
    removal.mockRestore();
  }
  const replacement = source("newer-submission");
  const remove = sessionStorage.removeItem.bind(sessionStorage);
  vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
    if (key === target.blobKey) {
      sessionStorage.setItem(key, replacement);
      throw new Error("Source changed during removal");
    }
    remove(key);
  });
  const migrated = readStore();
  expect(sessionStorage.getItem(target.blobKey)).toBe(replacement);
  expect(migrated.sessions[privateScope]?.queue).toMatchObject([{ id: "submitted" }]);
});

it.each([1, 3])("retires v%i private input after failed deletion without replay", (version) => {
  const { key: sourceKey, source } = seedSource(target, version, {
    [privateScope]: {
      ...privateInput(),
      queue: [queued("submitted", { text: "Submitted message" })],
      updatedAt: 1,
    },
    "main\u0000agent:main": { draft: "Ambiguous input", updatedAt: 1 },
  });
  const blocked = { removal: true, writes: true };
  const remove = sessionStorage.removeItem.bind(sessionStorage);
  const write = sessionStorage.setItem.bind(sessionStorage);
  vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
    if (key === sourceKey && blocked.removal) {
      throw new Error("Source deletion unavailable");
    }
    remove(key);
  });
  vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
    if (key === sourceKey && blocked.writes) {
      throw new Error("Source writes unavailable");
    }
    write(key, value);
  });
  const migrated = readStore();
  expect(sessionStorage.getItem(sourceKey)).toBe(source);
  expect(migrated.sessions[privateScope]?.queue).toMatchObject([
    { id: "submitted", text: "Submitted message" },
  ]);
  expect(Object.values(migrated.recovery)[0]?.session.draft).toBe("Ambiguous input");
  blocked.writes = false;
  expect(readStore()).toEqual(migrated);
  const retained = sessionStorage.getItem(sourceKey) ?? "";
  for (const privateValue of ["private legacy input", "profileId", "private-goal"]) {
    expect(retained).not.toContain(privateValue);
  }
  expect(readStore()).toEqual(migrated);
  blocked.removal = false;
  expect(readStore()).toEqual(migrated);
  expect(sessionStorage.getItem(sourceKey)).toBeNull();
});

it.each([1, 3])(
  "retires v%i deferred private input, preserving queues and ambiguity",
  (version) => {
    const item = queued("submitted", { text: "Submitted private message" });
    const privateRow = {
      ...privateInput(),
      draftRevision: 7,
      queue: [item],
      updatedAt: 1,
      unknownMetadata: "preserve",
    };
    const sessions = {
      [privateScope]: privateRow,
      "agent:main:dashboard:incognito-draft-only\u0000agent:main": {
        draft: "Private draft without an explicit revision",
        updatedAt: 2,
      },
      "agent:main:dashboard:incognito-goal-only\u0000agent:main": {
        goalMode: { action: "start", sessionId: "private-goal" },
        updatedAt: 3,
      },
      "main\u0000agent:main": { draft: "Ambiguous input", updatedAt: 1 },
    };
    const { key: sourceKey, source } = seedSource(target, version, sessions);
    const store = seedStore(
      target,
      {},
      recoveryRows((index) =>
        recoveryRow("main\u0000agent:main", storedSession({ draft: `Existing ${index}` })),
      ),
    );
    expect(readStore().recoveryBlocked).toBe(true);
    const retained = storedJson(sourceKey);
    const { draft: _draft, draftMentions: _mentions, goalMode: _goal, ...preserved } = privateRow;
    expect(retained).toEqual({
      ...JSON.parse(source),
      sessions: {
        [privateScope]: preserved,
        "main\u0000agent:main": sessions["main\u0000agent:main"],
      },
    });
    expect(storedJson(target.key)).toEqual(store);
    expect(storedJson(sourceKey)).toEqual(retained);
    sessionStorage.setItem(target.key, JSON.stringify({ ...store, recovery: {} }));
    const remove = sessionStorage.removeItem.bind(sessionStorage);
    vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => {
      if (key !== sourceKey) {
        remove(key);
      }
    });
    const migrated = readStore();
    expect(Object.values(migrated.recovery).flatMap((entry) => entry.session.queue ?? [])).toEqual([
      item,
    ]);
    expect(Object.values(migrated.recovery)).toHaveLength(2);
    expect(sessionStorage.getItem(sourceKey)).not.toBeNull();
    expect(readStore()).toEqual(migrated);
  },
);

it("admits legacy input through full clear fences without replay", () => {
  const state = ownedState(target.gatewayOwner);
  const scopeKey = "global\u0000agent:main";
  const fence = { draftRevision: 100, updatedAt: 100 };
  seedStore(
    target,
    { [scopeKey]: fence },
    recoveryRows((index) =>
      recoveryRow(
        "old-" + index + "\u0000agent:main",
        { draftRevision: index + 1, updatedAt: index + 1 },
        3,
      ),
    ),
  );
  const source = sourceJson(target, 3, {
    [scopeKey]: draftSession("real saved input", 101),
    "main\u0000agent:main": { draftRevision: 99, updatedAt: 99 },
  });
  sessionStorage.setItem(target.blobKey, source);
  const recovery = readChatOutboxRecovery(state);
  expect(recovery.blocked).toBe(false);
  expect(recovery.entries.map((entry) => entry.session.draft)).toEqual(["real saved input"]);
  expect(Object.keys(readStore().recovery)).toHaveLength(1);
  expect(readStore().sessions[scopeKey]).toEqual(fence);
  expect(discardChatOutboxRecovery(state, recovery.entries[0]!)).toBe("discarded");
  // A failed old-source deletion or downgraded writer cannot replay acknowledged bytes.
  sessionStorage.setItem(target.blobKey, source);
  expect(readChatOutboxRecovery(state)).toEqual({ entries: [], blocked: false });
  expect(readStore().sessions[scopeKey]).toEqual(fence);
});

it("retires private recovery and rejects pre-roster private destinations", () => {
  const sessionKey = "agent:main:dashboard:incognito-recovery";
  const scopeKey = storedChatOutboxScopeKey({ sessionKey });
  seedStore(
    target,
    {},
    {
      legacy: recoveryRow(scopeKey, {
        draft: "private recovery input",
        draftRevision: 4,
        updatedAt: 1,
        queue: [{ id: "submitted", text: "Submitted message", createdAt: 1, sendState: "held" }],
      }),
    },
  );
  const state = {
    settings: { gatewayUrl: target.gatewayOwner },
    agentsList: { defaultId: "main", mainKey: "main" },
  };
  const entries = readChatOutboxRecovery(state).entries;
  expect(entries[0]?.session).toEqual({
    draftRevision: 4,
    updatedAt: 1,
    queue: [{ id: "submitted", text: "Submitted message", createdAt: 1, sendState: "held" }],
  });
  expect(sessionStorage.getItem(target.key)).not.toContain("private recovery input");
  expect(captureChatOutboxRecoveryDestination(state, { sessionKey })).toBeNull();
});

it.each([
  ["valid", undefined],
  ["out of range", [mention(0, 50)]],
  ["missing prefix", [mention(1)]],
  ["malformed", "profile-alex"],
] as const)("restores valid mentions and parks invalid metadata: %s", (_reason, invalid) => {
  const scopeKey = storedChatOutboxScopeKey({ sessionKey: "agent:main:mentions" });
  const mentions = [mention()];
  const item = queued(invalid === undefined ? "mention-send" : "corrupt-mention", {
    text: invalid === undefined ? "@Alex queued" : "@Alex review",
    sendState: "waiting-reconnect",
  });
  if (invalid === undefined) {
    const store = readStore();
    store.sessions[scopeKey] = storedSession({
      draft: "@Alex draft",
      draftMentions: mentions,
      queue: [{ ...item, mentions, sendRunId: "mention-run" }],
    });
    writeStoredOutboxStore(sessionStorage, target, store);
    mentions[0]!.profileId = "later-selection";
  } else {
    seedSource(target, 4, {
      [scopeKey]: { updatedAt: 1, queue: [{ ...item, mentions: invalid }] },
    });
  }
  const restored = readStore().sessions[scopeKey];
  if (invalid === undefined) {
    expect(restored).toMatchObject({
      draft: "@Alex draft",
      draftMentions: [mention()],
      queue: [{ ...item, mentions: [mention()], sendRunId: "mention-run" }],
    });
  } else {
    expect(restored?.queue?.[0]).toMatchObject({ text: "@Alex review", sendState: "failed" });
    expect(restored?.queue?.[0]?.mentions).toBeUndefined();
    expect(restored?.queue?.[0]?.sendError).toBeTruthy();
  }
});

it.each([1, 2, 4])("refreshes a cached v%i projection after an external write", (version) => {
  const reader = createStoredChatOutboxReader();
  const changed = vi.fn();
  cleanups.push(reader.subscribe(changed));
  const state = { settings: { gatewayUrl }, client: null, connected: false };
  const storageKey = `openclaw.control.chatComposer.v${version}:${encodeURIComponent(gatewayUrl)}`;
  const stored = (ids: string[]) =>
    sourceJson(target, version, {
      "agent:main:summary\u0000agent:main": {
        ...(ids.length > 1 ? { draft: "new" } : {}),
        queue: ids.map((id, createdAt) => queued(id, { createdAt })),
        updatedAt: ids.length,
      },
    });
  sessionStorage.setItem(storageKey, stored(["first"]));
  if (version !== 4) {
    const write = sessionStorage.setItem.bind(sessionStorage);
    vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
      if (key !== storageKey) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
  }
  const first = readProjectedOutboxStore(sessionStorage, target);
  expect(readProjectedOutboxStore(sessionStorage, target)).toBe(first);
  expect(queueItems(first)).toHaveLength(1);
  expect(createStoredChatOutboxReader().read(ownedState(gatewayUrl)).total).toBe(0);
  const summary = reader.read(state);
  expect(reader.read({ ...state })).toBe(summary);
  expect(summary.hasSessionDraft("agent:main:summary")).toBe(false);
  sessionStorage.setItem(storageKey, stored(["first", "second"]));
  storageEvent(storageKey);
  const refreshed = readProjectedOutboxStore(sessionStorage, target);
  expect(refreshed).not.toBe(first);
  expect(queueItems(refreshed)).toHaveLength(2);
  expect(changed).toHaveBeenCalledOnce();
  expect(reader.read(state)).not.toBe(summary);
  expect(reader.read(state).hasSessionDraft("agent:main:summary")).toBe(true);
  expect(
    reader
      .read({ ...state, settings: { gatewayUrl: "ws://other.test" } })
      .hasSessionDraft("agent:main:summary"),
  ).toBe(false);
  expect(reader.read(state).hasSessionDraft("agent:main:summary")).toBe(true);
  const reconnected = reader.read(state);
  reader.invalidate();
  expect(reader.read(state)).not.toBe(reconnected);
});

it.each([1, 3])("retains the last v%i source when quota blocks verified retirement", (version) => {
  const scopeKey = storedChatOutboxScopeKey({ sessionKey: "thread", agentId: "main" });
  const { key: sourceKey } = seedSource(target, version, {
    [scopeKey]: storedSession({ queue: [queued("queued", { text: "retire me" })] }),
  });
  vi.spyOn(sessionStorage, "setItem").mockImplementation(quotaExceeded);
  const store = readStore();
  expect(store.sessions[scopeKey]?.queue).toHaveLength(1);
  store.sessions = {};
  expect(() => writeStoredOutboxStore(sessionStorage, target, store)).toThrow("quota exceeded");
  expect(readStore().sessions[scopeKey]?.queue).toEqual([
    { id: "queued", text: "retire me", createdAt: 1, sessionKey: "thread" },
  ]);
  expect(sessionStorage.getItem(sourceKey)).toContain("retire me");
});

it("invalidates all projections and unsubscribes storage listeners independently", () => {
  const first = vi.fn(),
    second = vi.fn();
  const offFirst = subscribeStoredChatOutboxChanges(first);
  const offSecond = subscribeStoredChatOutboxChanges(second);
  storageEvent("openclaw.control.settings.v1");
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 0]);
  const gatewayUrls = ["ws://first.test/control", "ws://second.test/control"];
  for (const storageGateway of gatewayUrls) {
    seedStore(storageTargetForGateway(storageGateway, "summary-owner"), {
      "thread\u0000agent:main": storedSession({
        queue: ownedQueue(storageGateway, [queued(storageGateway)]),
      }),
    });
    expect(createStoredChatOutboxReader().read(ownedState(storageGateway)).total).toBe(1);
  }
  sessionStorage.clear();
  storageEvent(null);
  for (const storageGateway of gatewayUrls) {
    expect(createStoredChatOutboxReader().read(ownedState(storageGateway)).total).toBe(0);
  }
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 1]);
  storageEvent(target.key);
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([2, 2]);
  offFirst();
  storageEvent(target.legacyKey);
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([2, 3]);
  offSecond();
  storageEvent(target.key);
  expect([first.mock.calls.length, second.mock.calls.length]).toEqual([2, 3]);
});

it.each([
  ["agent:main:main", "agent:main:current", 11, false, false],
  ["global", "newer", 1_000, true, false],
  ["older", "newer", 1_000, false, true],
] as const)(
  "retires captured %s while preserving other drafts",
  (oldKey, otherKey, revision, failed, batch) => {
    const agentId = failed ? "work" : "main";
    const scope = storedChatOutboxScopeKey({ sessionKey: oldKey, agentId });
    const other = storedChatOutboxScopeKey({ sessionKey: otherKey });
    const replacement = draftSession("replacement", revision);
    seedStore(target, {
      [scope]: {
        ...draftSession("retire me", 10),
        ...(revision === 11 ? {} : { queue: [queued("queued")] }),
      },
      ...(failed ? {} : { [other]: replacement }),
    });
    const before = sessionStorage.getItem(target.key);
    if (failed) {
      vi.spyOn(sessionStorage, "setItem").mockImplementationOnce(quotaExceeded);
    }
    const listener = vi.fn();
    cleanups.push(subscribeStoredChatOutboxChanges(listener));
    const cutoff = batch ? 100 : 20;
    const result = retireStoredComposerDrafts(
      {
        settings: { gatewayUrl: target.gatewayOwner },
        agentsList: { defaultId: "main", mainKey: "current", scope: "per-sender" },
      },
      [
        { key: oldKey, agentId, retireBeforeRevision: cutoff },
        ...(batch ? [{ key: otherKey, agentId: "main", retireBeforeRevision: cutoff }] : []),
      ],
    );
    expect(result.storageFailed).toBe(failed);
    expect(result.retirements[0]).toEqual({
      scope: { sessionKey: oldKey, agentId },
      minimumRevision: expect.any(Number),
      retireBeforeRevision: cutoff,
    });
    if (failed) {
      expect(sessionStorage.getItem(target.key)).toBe(before);
    } else {
      const stored = readStore().sessions;
      expect(stored[scope]).toEqual({
        draftRevision: expect.any(Number),
        updatedAt: expect.any(Number),
      });
      expect(stored[scope]?.draftRevision).toBeGreaterThan(cutoff);
      expect(stored[other]).toEqual(replacement);
      expect(listener).toHaveBeenCalledOnce();
    }
  },
);

it("queries unresolved main drafts before defaults arrive", () => {
  seedStore(storageTargetForGateway(gatewayUrl, "summary-owner"), {
    "main\u0000agent:@unresolved": draftSession("pending draft", 3),
  });
  const summary = createStoredChatOutboxReader().read({ ...ownedState(gatewayUrl), hello: null });
  expect(summary.hasSessionDraft("main")).toBe(true);
  expect(summary.hasSessionDraft("agent:main:main")).toBe(false);
});

it("projects metadata-only badges and counts distinct operator-review rows", () => {
  const queue = [
    ...(
      [undefined, "waiting-idle", "executing-command", "sending", "waiting-reconnect"] as const
    ).map((sendState, index) => queued("healthy-" + index, { sendState })),
    queued("held", { sendState: "held" }),
    ...(["failed", "waiting-reconnect"] as const).flatMap((sendState) =>
      [1, 2].map(() => queued(sendState, { sendState })),
    ),
    queued("other-owner", {
      sendState: "failed",
      attachmentPayload: { key: "bundle", recoveryScope: "other-owner", tabId: "tab" },
    }),
  ];
  seedStore(storageTargetForGateway(gatewayUrl, "summary-owner"), {
    "agent:main:a\u0000agent:main": storedSession({ draft: "private draft" }),
    "thread-empty\u0000agent:main": storedSession({ draftRevision: 1 }),
    "agent:work:b\u0000agent:work": storedSession({ queue: ownedQueue(gatewayUrl, queue) }),
    "thread-b\u0000agent:main": storedSession({
      queue: ownedQueue(gatewayUrl, [
        queued("waiting-reconnect", { sendState: "waiting-reconnect" }),
      ]),
    }),
  });
  const summary = createStoredChatOutboxReader().read(ownedState(gatewayUrl));
  const read = vi.spyOn(sessionStorage, "getItem");
  sessionStorage.clear();
  expect(summary.total).toBe(9);
  expect(summary.sessions).toEqual([
    badge("agent:main:a", "main", true),
    badge("agent:work:b", "work", false, 3),
  ]);
  expect(summary.attentionCountForSession("agent:work:b")).toBe(3);
  expect(summary.attentionCountForSession("thread-b")).toBe(0);
  expect(summary.attentionCountForSession("absent")).toBe(0);
  expect(summary.hasSessionDraft("agent:main:a")).toBe(true);
  expect(summary.hasSessionDraft("agent:work:b")).toBe(false);
  expect(summary.hasSessionDraft("thread-empty")).toBe(false);
  expect(summary.hasSessionDraft("absent")).toBe(false);
  expect(read).not.toHaveBeenCalled();
});

it("filters legacy queue tombstones before offering recovery", () => {
  seedSource(target, 1, {
    "main\u0000agent:previous": {
      queue: [queued("removed"), queued("shared", { text: "older", createdAt: 2 })],
      removedQueueItemIds: ["removed"],
      updatedAt: 2,
    },
  });
  const recovery = readChatOutboxRecovery(ownedState());
  expect(recovery.entries).toHaveLength(1);
  expect(recovery.entries[0]?.session.queue).toEqual([
    queued("shared", { text: "older", createdAt: 2 }),
  ]);
  expect(sessionStorage.getItem(target.legacyKey)).toBeNull();
});

const scopeKey = storedChatOutboxScopeKey;
const transferUrl = "wss://transfer.test";
const sourceScope = "agent:main:old\u0000agent:main";
const firstScope = { sessionKey: "agent:main:first", agentId: "main" };
const secondScope = { sessionKey: "agent:main:second", agentId: "main" };
const attachment = { id: "file", mimeType: "text/plain", fileName: "saved.txt" };
const storageScope = JSON.stringify([transferUrl, "account-a"]);
const deliveredMessage = (idempotencyKey = "attempt", local = false) => ({
  role: "user",
  content: "queue 雪",
  __openclaw: { id: local ? null : "delivered", seq: null, idempotencyKey },
});
const queueItem = (overrides: Partial<ChatQueueItem> = {}) =>
  queued("input", { text: "queue 雪", ...overrides });
const submittedItem = () =>
  queueItem({
    sendRunId: "attempt",
    sendAttempts: 1,
    sendState: "waiting-reconnect",
    sessionId: "session",
  });
const recovery = (
  session: StoredComposerSession,
  sourceVersion: StoredComposerRecovery["sourceVersion"] = 4,
): StoredComposerRecovery => ({
  sourceVersion,
  sourceScopeKey: sourceScope,
  session,
});
function fixture(kind: "queue" | "draft", sibling = false, originalScope = sourceScope) {
  const state = {
    settings: { gatewayUrl: transferUrl },
    connected: true,
    client: { recoveryScope: "account-a", recoveryScopeReady: true },
    agentsList: { defaultId: "main", mainKey: "main", scope: "per-sender" },
    sessionKey: firstScope.sessionKey,
    chatMessage: "",
    chatQueue: [],
  };
  const session = storedSession({
    draftRevision: 1,
    ...(kind === "draft" ? { draft: "draft 雪" } : { queue: [submittedItem()] }),
  });
  const source = storageTargetForGateway(transferUrl);
  seedStore(source, {
    [originalScope]: session,
    ...(sibling
      ? { "agent:main:sibling\u0000agent:main": storedSession({ draft: "untouched" }, 2) }
      : {}),
  });
  const entry = () =>
    readChatOutboxRecovery(state).entries.find((row) => row.sourceScopeKey === originalScope)!;
  const destination = (scope = firstScope) => captureChatOutboxRecoveryDestination(state, scope)!;
  const stored = () => readStoredOutboxStore(sessionStorage, storageTargetForComposer(state));
  const entries = () => readChatOutboxRecovery(state).entries;
  return {
    state,
    session,
    source,
    entry,
    stored,
    entries,
    legacy: () => readStoredOutboxStore(sessionStorage, source),
    saveLegacy: (store: ReturnType<typeof stored>) =>
      writeStoredOutboxStore(sessionStorage, source, store),
    save: (store: ReturnType<typeof stored>) =>
      writeStoredOutboxStore(sessionStorage, storageTargetForComposer(state), store),
    restore: (row = entry(), scope = firstScope) =>
      restoreChatOutboxRecovery(state, row, destination(scope)),
    discard: (row = entry(), isCurrent?: () => boolean) =>
      discardChatOutboxRecovery(state, row, isCurrent),
    retire: (rows = entries()) => retireDeliveredChatOutboxRecovery(state, rows),
    expectRetained: () => {
      expect(stored().sessions).toEqual({});
      expect(entry().session).toEqual(session);
    },
  };
}

function reopenStorage() {
  const reopened = createStorageMock();
  for (let index = 0; index < sessionStorage.length; index++) {
    const key = sessionStorage.key(index)!;
    reopened.setItem(key, sessionStorage.getItem(key)!);
  }
  vi.stubGlobal("sessionStorage", reopened);
}

function interceptTransfer(
  f: ReturnType<typeof fixture>,
  intercept: (stage: string, commit: () => void) => void,
) {
  const set = sessionStorage.setItem.bind(sessionStorage);
  const remove = sessionStorage.removeItem.bind(sessionStorage);
  const ownedKey = storageTargetForComposer(f.state).key;
  const apply = (key: string, value?: string) => {
    const commit = () => (value === undefined ? remove(key) : set(key, value));
    if (key !== f.source.key && key !== ownedKey) {
      commit();
      return;
    }
    const source = key === f.source.key;
    let stage = source ? "retire-remove" : "discard";
    if (value !== undefined) {
      const record = JSON.parse(value) as Pick<StoredComposerState, "recovery">;
      const staging = Object.values(record.recovery).some(
        (row) => row.sourceScopeKey === sourceScope,
      );
      stage = source ? (staging ? "claim" : "retire-write") : staging ? "stage" : "publish";
    }
    intercept(stage, commit);
  };
  const writes = vi
    .spyOn(sessionStorage, "setItem")
    .mockImplementation((key, value) => apply(key, value));
  const removals = vi.spyOn(sessionStorage, "removeItem").mockImplementation((key) => apply(key));
  return () => {
    writes.mockRestore();
    removals.mockRestore();
  };
}

function deliveryFixture(idempotencyKey = "attempt") {
  const f = fixture("queue");
  const state = Object.assign(f.state, {
    sessionKey: "agent:main:old",
    currentSessionId: "session",
    chatMessages: [deliveredMessage(idempotencyKey)] as unknown[],
  });
  return { ...f, state };
}

function fillDestination(f: ReturnType<typeof fixture>, occupied: "queue" | "pending" | "draft") {
  const store = f.stored();
  const prefix = occupied === "pending" ? "opaque-" : `agent:main:${occupied}-`;
  const key = (index: number) => `${prefix}${index}\u0000agent:main`;
  for (let index = 0; index < 20; index++) {
    store.sessions[key(index)] = storedSession(
      {
        queue: occupied === "queue" ? [queueItem({ id: String(index), storageScope })] : undefined,
        draft: occupied === "queue" ? undefined : String(index),
        awaitingDefaults: occupied === "pending" ? true : undefined,
      },
      index + 1,
    );
  }
  f.save(store);
  return key;
}

it.each(["attempt", "attempt:user"])("retires delivered %s", (idempotencyKey) => {
  const f = deliveryFixture(idempotencyKey);
  expect(f.retire()).toBe("retired");
  expect(f.entries()).toEqual([]);
  expect([f.stored().recovery, f.stored().sessions]).toEqual([{}, {}]);
  expect(f.state).toMatchObject({ chatQueue: [], chatMessage: "" });
});

it.each([
  "local-copy",
  "session",
  "scope",
  "text-only",
  "assistant",
  "no-run-id",
  "unowned-draft",
] as const)("keeps saved queue input when delivery retirement is unsafe: %s", (mismatch) => {
  const f = deliveryFixture();
  const message = deliveredMessage(
    mismatch === "text-only" ? "another-attempt" : "attempt",
    mismatch === "local-copy",
  );
  message.role = mismatch === "assistant" ? "assistant" : "user";
  f.state.chatMessages = [message];
  if (mismatch === "session") {
    f.state.currentSessionId = "replacement-session";
  } else if (mismatch === "scope") {
    f.state.sessionKey = firstScope.sessionKey;
  } else if (mismatch === "no-run-id" || mismatch === "unowned-draft") {
    const legacy = f.legacy();
    if (mismatch === "no-run-id") {
      delete legacy.sessions[sourceScope]!.queue![0]!.sendRunId;
    } else {
      legacy.sessions[sourceScope]!.draft = "Keep this draft";
      f.state.chatMessages = [
        { role: "user", __openclaw: { seq: 7, idempotencyKey: "attempt:user" } },
      ];
    }
    f.saveLegacy(legacy);
  }
  const before = sessionStorage.getItem(f.source.key);
  const entries = f.entries();
  expect(f.retire(entries)).toBe("unchanged");
  expect(f.entries()).toEqual(entries);
  expect(sessionStorage.getItem(f.source.key)).toBe(before);
  expect(f.stored().recovery).toEqual({});
});

it("retains the draft and unproven inputs when only one owned submission was delivered", () => {
  const f = deliveryFixture();
  const legacy = f.legacy();
  const delivered = legacy.sessions[sourceScope]!.queue![0]!;
  legacy.sessions = {};
  f.saveLegacy(legacy);
  const owned = f.stored();
  owned.recovery.owned = recovery({
    draft: "Keep this draft",
    updatedAt: 1,
    queue: [delivered, queueItem({ id: "unsent", text: "Still unsent", createdAt: 2 })],
  });
  f.save(owned);
  f.state.chatMessages = [{ role: "user", __openclaw: { seq: 7, idempotencyKey: "attempt:user" } }];
  expect(f.retire()).toBe("retired");
  expect(f.entries()).toMatchObject([
    { id: "owned", session: { draft: "Keep this draft", queue: [{ id: "unsent" }] } },
  ]);
  expect(f.entries()[0]!.session.queue).toHaveLength(1);
});

it.each(["recovery", "history"] as const)("fences retirement after %s changes", (change) => {
  const f = deliveryFixture();
  const entries = f.entries();
  if (change === "recovery") {
    const legacy = f.legacy();
    legacy.sessions[sourceScope]!.draft = "Newer intent";
    f.saveLegacy(legacy);
  } else {
    interceptTransfer(f, (stage, commit) => {
      commit();
      if (stage === "claim" || stage === "retire-write") {
        f.state.chatMessages = [];
      }
    });
  }
  const before = sessionStorage.getItem(f.source.key);
  expect(f.retire(entries)).toBe("conflict");
  if (change === "recovery") {
    expect(sessionStorage.getItem(f.source.key)).toBe(before);
  }
  expect(f.entries()[0]?.session.queue).toHaveLength(1);
});

it("offers textless recovery input but preserves and hides canonical clear fences", () => {
  const f = fixture("draft");
  const fence = { updatedAt: 12, draftRevision: 12 };
  const legacy = f.legacy();
  legacy.sessions["global\u0000agent:main"] = fence;
  legacy.recovery = {
    cleared: recovery(fence, 3),
    attachment: recovery(
      storedSession({ queue: [queueItem({ text: "", attachments: [attachment] })] }),
    ),
    goal: recovery(storedSession({ goalMode: { action: "start" } }, 2)),
    reply: recovery(storedSession({ replyTarget: { messageId: "message", text: "quoted" } }, 3)),
  };
  f.saveLegacy(legacy);
  const owned = f.stored();
  owned.recovery.cleared = recovery(fence);
  f.save(owned);
  const before = sessionStorage.getItem(f.source.key);
  expect(f.entries().map((entry) => entry.id)).toEqual([
    "legacy-session:" + sourceScope,
    ...["attachment", "goal", "reply"].map((id) => "legacy-recovery:" + id),
  ]);
  expect(f.entries()[0]?.session.draft).toBe("draft 雪");
  expect(sessionStorage.getItem(f.source.key)).toBe(before);
  expect(f.stored().recovery.cleared).toBeUndefined();
  expect(f.legacy().sessions["global\u0000agent:main"]).toEqual(fence);
});

it.each(["account", "gateway", "revision", "incognito", "confirmation"] as const)(
  "fences discard after %s changes",
  (change) => {
    const f = fixture("draft");
    const entry = f.entry();
    if (change === "revision") {
      const legacy = f.legacy();
      legacy.sessions[sourceScope] = { draft: "newer", draftRevision: 2, updatedAt: 2 };
      f.saveLegacy(legacy);
    } else if (change === "account") {
      f.state.client.recoveryScope = "account-b";
    } else if (change === "gateway") {
      f.state.settings.gatewayUrl = "wss://other.test";
    } else if (change === "incognito") {
      Object.assign(f.state, { selectedChatSessionIncognito: true });
    }
    const before = sessionStorage.getItem(f.source.key);
    expect(f.discard(entry, () => change !== "confirmation")).toBe("conflict");
    expect(sessionStorage.getItem(f.source.key)).toBe(before);
    expect(f.stored().sessions).toEqual({});
  },
);

it("discards recovery without changing the composer, then retires its attachment payload", () => {
  const f = fixture("queue", true);
  const reference = { key: "blob", tabId: "this-tab", recoveryScope: "account-a" };
  const legacy = f.legacy();
  legacy.sessions[sourceScope]!.draft = "discard draft";
  Object.assign(legacy.sessions[sourceScope]!.queue![0]!, {
    attachmentPayload: reference,
    attachments: [attachment],
  });
  f.saveLegacy(legacy);
  const owned = f.stored();
  owned.sessions[scopeKey(firstScope)] = draftSession("current", 10);
  f.save(owned);
  f.state.chatMessage = "current";
  const entry = f.entry();
  const remaining = () => f.entries().map((row) => row.session.draft);
  const cleanup = vi.spyOn(payloadStore, "removeOutboxPayloads").mockImplementation(async () => {
    expect(remaining()).toEqual(["untouched"]);
  });
  expect(f.discard(entry)).toBe("discarded");
  expect(f.state.chatMessage).toBe("current");
  expect(f.stored().sessions).toEqual(owned.sessions);
  expect(remaining()).toEqual(["untouched"]);
  expect(f.discard(entry)).toBe("conflict");
  expect(cleanup).toHaveBeenCalledExactlyOnceWith([reference]);
});

const stages = ["claim", "stage", "retire-write", "retire-remove", "publish"] as const;
const transferCases = stages.flatMap((stage) =>
  (["throw", "after-write"] as const).flatMap((failure) =>
    (stage === "publish" ? (["queue", "draft"] as const) : (["queue"] as const)).map(
      (kind) => [stage, failure, kind, false] as const,
    ),
  ),
);
it.each([
  ...transferCases,
  ...["claim", "stage", "retire-remove", "discard"].map(
    (stage) => [stage, "throw", "queue", true] as const,
  ),
])("retains input across %s %s (%s, discard=%s)", (stage, failure, kind, discard) => {
  const f = fixture(kind, stage === "retire-write");
  const original = f.entry();
  let failed = false;
  const reset = interceptTransfer(f, (currentStage, commit) => {
    if (currentStage === stage) {
      failed = true;
      if (failure === "after-write") {
        commit();
      }
      throw new Error("Injected " + stage);
    }
    commit();
  });
  expect(discard ? f.discard(original) : f.restore(original)).toBe("storage-failed");
  expect(failed).toBe(true);
  reset();
  reopenStorage();
  const committed = stage === "publish" && failure === "after-write";
  if (committed) {
    expect(f.entry()).toBeUndefined();
    expect(f.restore(original, secondScope)).toBe("conflict");
  } else {
    f.expectRetained();
    expect(f.entries().filter((row) => row.sourceScopeKey === sourceScope)).toHaveLength(1);
    expect(discard ? f.discard() : f.restore(f.entry(), secondScope)).toBe(
      discard ? "discarded" : "restored",
    );
  }
  const sessions = f.stored().sessions;
  if (discard) {
    expect(sessions).toEqual({});
  } else {
    const scope = committed ? firstScope : secondScope;
    const key = scopeKey(scope);
    expect(Object.keys(sessions)).toEqual([key]);
    expect(sessions[key]).toMatchObject(
      kind === "draft"
        ? { draft: f.session.draft }
        : {
            queue: [{ id: "input", text: "queue 雪", ...scope, storageScope }],
          },
    );
  }
  expect(f.entries().filter((row) => row.sourceScopeKey === sourceScope)).toEqual([]);
  if (stage === "retire-write") {
    expect(f.entries()[0]?.session.draft).toBe("untouched");
  }
});

it.each([
  [sourceScope, "agent:main:old", true, {}],
  ["main\u0000agent:main", "agent:main:main", true, {}],
  [sourceScope, firstScope.sessionKey, false, { attachments: [attachment] }],
  [
    sourceScope,
    firstScope.sessionKey,
    true,
    { intent: { kind: "session-goal-start", version: 1, issuedAtMs: 1 } },
  ],
  [sourceScope, firstScope.sessionKey, true, { localCommandName: "clear" }],
  [sourceScope, firstScope.sessionKey, true, { queueMode: "steer" }],
] satisfies Array<[string, string, boolean, Partial<ChatQueueItem>]>)(
  "preserves admission when restoring %s to %s (retained=%s)",
  (source, destination, retained, input) => {
    const f = fixture("queue", false, source);
    const legacy = f.legacy();
    Object.assign(legacy.sessions[source]!.queue![0]!, input);
    f.saveLegacy(legacy);
    const scope = { sessionKey: destination, agentId: "main" };

    expect(f.restore(f.entry(), scope)).toBe("restored");

    const restored = f.stored().sessions[scopeKey(scope)]?.queue?.[0];
    expect(restored).toMatchObject({
      ...input,
      sendAttempts: retained ? 1 : 0,
      sendState: retained ? "held" : "failed",
    });
    if (retained) {
      expect(restored).toMatchObject({
        sendRunId: "attempt",
        sessionId: "session",
      });
    } else {
      expect(restored).not.toHaveProperty("sendRunId");
      expect(restored).not.toHaveProperty("sessionId");
    }
  },
);

it.each([
  ...(["account", "client"] as const).map((change) => ({
    boundary: "claim" as const,
    change,
  })),
  ...(["stage", "retire"] as const).map((boundary) => ({ boundary, change: "account" as const })),
])("retains recovery across reentrant $change replacement at $boundary", ({ boundary, change }) => {
  const f = fixture("draft");
  const original = f.entry();
  let changed = false;
  const reset = interceptTransfer(f, (stage, commit) => {
    commit();
    if (!changed && stage === (boundary === "retire" ? "retire-remove" : boundary)) {
      changed = true;
      if (change === "account") {
        f.state.client.recoveryScope = "account-b";
      } else {
        f.state.client = { ...f.state.client };
      }
    }
  });
  expect(f.restore(original)).toBe("conflict");
  reset();
  expect(changed).toBe(true);
  if (change === "account") {
    expect(f.entries()).toEqual([]);
    f.state.client.recoveryScope = "account-a";
  }
  f.expectRetained();
  expect(f.restore(f.entry(), secondScope)).toBe("restored");
  expect(f.stored().sessions[scopeKey(secondScope)]?.draft).toBe(f.session.draft);
  if (boundary !== "claim") {
    expect(Object.keys(f.stored().sessions)).toEqual([scopeKey(secondScope)]);
  }
});

it.each([
  { kind: "queue", occupied: "queue" },
  { kind: "draft", occupied: "queue" },
  { kind: "draft", occupied: "pending" },
  { kind: "queue", occupied: "draft" },
] as const)("retains $kind when destination is full of $occupied", ({ kind, occupied }) => {
  const f = fixture(kind);
  const key = fillDestination(f, occupied);
  const before = f.stored().sessions;
  expect(f.restore()).toBe("storage-failed");
  expect(f.stored().sessions).toEqual(before);
  expect(Object.keys(f.stored().sessions)).toHaveLength(20);
  reopenStorage();
  expect(f.entry().session).toEqual(f.session);
  if (occupied === "pending") {
    const ordinary = f.stored();
    ordinary.sessions[scopeKey(firstScope)] = { ...f.session, updatedAt: Date.now() };
    f.save(ordinary);
    expect(f.stored().sessions[scopeKey(firstScope)]).toBeUndefined();
    expect(f.entry().session).toEqual(f.session);
  }
  const freed = f.stored();
  delete freed.sessions[key(0)];
  f.save(freed);
  expect(f.restore(f.entry(), secondScope)).toBe("restored");
  const after = f.stored().sessions;
  expect(Object.keys(after)).toHaveLength(20);
  for (let index = 1; index < 20; index++) {
    expect(after[key(index)]).toEqual(before[key(index)]);
  }
  expect(after[scopeKey(secondScope)]).toMatchObject(
    kind === "draft" ? { draft: f.session.draft } : { queue: [{ id: "input" }] },
  );
  expect(after[scopeKey(firstScope)]).toBeUndefined();
  expect(f.entries()).toEqual([]);
});
