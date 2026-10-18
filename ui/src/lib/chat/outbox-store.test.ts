/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatQueueItem } from "./chat-types.ts";
import { outboxStorageScope } from "./outbox-payload-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  discardChatOutboxRecovery,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "./outbox-recovery.ts";
import type { StoredComposerState } from "./outbox-store-codec.ts";
import { createStoredChatOutboxReader, listStoredChatOutboxes } from "./outbox-store-projection.ts";
import { retireStoredComposerDrafts } from "./outbox-store-retirement.ts";
import {
  readProjectedOutboxStore,
  readStoredOutboxStore,
  storedChatOutboxScopeKey,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
  writeStoredOutboxStore,
} from "./outbox-store.ts";

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

const queued = (id: string, overrides: Partial<ChatQueueItem> = {}): ChatQueueItem => ({
  id,
  text: id,
  createdAt: 1,
  ...overrides,
});
const storedSession = (overrides: Partial<StoredComposerState["sessions"][string]> = {}) => ({
  updatedAt: 1,
  ...overrides,
});
const privateInput = () => ({
  draft: "@Alex private legacy input",
  draftMentions: [{ profileId: "alex", start: 0, end: 5 }],
  goalMode: { action: "start", sessionId: "private-goal" },
});
const readStore = () => readStoredOutboxStore(sessionStorage, target);
const queueItems = (store: StoredComposerState) =>
  Object.values(store.sessions).flatMap((entry) => entry.queue ?? []);
const storedJson = (key: string) => JSON.parse(sessionStorage.getItem(key)!);

function seedStore(
  target: ReturnType<typeof storageTargetForGateway>,
  sessions: StoredComposerState["sessions"],
  recovery: StoredComposerState["recovery"] = {},
) {
  const store = { version: 4, gatewayOwner: target.gatewayOwner, sessions, recovery };
  sessionStorage.setItem(target.key, JSON.stringify(store));
  return store;
}

function seedSource(
  target: ReturnType<typeof storageTargetForGateway>,
  version: number,
  sessions: Record<string, unknown>,
) {
  const key =
    version === 1
      ? target.legacyKey
      : version === 2
        ? target.previousKey
        : version === 3
          ? target.blobKey
          : target.key;
  const source = sourceJson(target, version, sessions);
  sessionStorage.setItem(key, source);
  return { key, source };
}

function sourceJson(
  target: ReturnType<typeof storageTargetForGateway>,
  version: number,
  sessions: Record<string, unknown>,
) {
  return JSON.stringify({
    version,
    ...(version !== 1 ? { gatewayOwner: target.gatewayOwner } : {}),
    ...(version === 4 ? { recovery: {} } : {}),
    sessions,
  });
}

const recoveryRow = (
  sourceScopeKey: string,
  session: StoredComposerState["sessions"][string],
  sourceVersion: 1 | 2 | 3 | 4 = 4,
) => ({ sourceVersion, sourceScopeKey, session });
const recoveryRows = (make: (index: number) => ReturnType<typeof recoveryRow>) =>
  Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`row-${index}`, make(index)]));
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
const globalAgents = { defaultId: "main", mainKey: "workspace", scope: "global" };
const selectedWork = { assistantAgentId: "work", agentsList: globalAgents };
const gatewayUrl = "ws://gateway.test/control";
const target = storageTargetForGateway(gatewayUrl);
const privateScope = "agent:main:dashboard:incognito-test\u0000agent:main";
const quotaExceeded = () => {
  throw new DOMException("quota exceeded", "QuotaExceededError");
};
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["raw", "cleared"])("preserves newer legacy bytes during %s retirement", (input) => {
  const scopeKey = privateScope;
  const source = (id: string) =>
    sourceJson(target, 3, {
      [scopeKey]: storedSession({ draft: "Private legacy input", queue: [queued(id)] }),
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
  expect(migrated.sessions[scopeKey]?.queue).toMatchObject([{ id: "submitted" }]);
});

it.each([1, 3])("retires v%i private input after failed deletion without replay", (version) => {
  const scopeKey = privateScope;
  const { key: sourceKey, source } = seedSource(target, version, {
    [scopeKey]: {
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
  expect(migrated.sessions[scopeKey]?.queue).toMatchObject([
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
    const scopeKey = privateScope;
    const item = queued("submitted", { text: "Submitted private message" });
    const privateRow = {
      ...privateInput(),
      draftRevision: 7,
      queue: [item],
      updatedAt: 1,
      unknownMetadata: "preserve",
    };
    const sessions = {
      [scopeKey]: privateRow,
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
    expect(() => readStore()).not.toThrow();
    const retained = storedJson(sourceKey);
    const { draft: _draft, draftMentions: _mentions, goalMode: _goal, ...preserved } = privateRow;
    expect(retained).toEqual({
      ...JSON.parse(source),
      sessions: {
        [scopeKey]: preserved,
        "main\u0000agent:main": sessions["main\u0000agent:main"],
      },
    });
    expect(storedJson(target.key)).toEqual(store);
    expect(readStore().recoveryBlocked).toBe(true);
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
    [scopeKey]: { draft: "real saved input", draftRevision: 101, updatedAt: 101 },
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
  if (invalid === undefined) {
    const store = readStore();
    store.sessions[scopeKey] = {
      draft: "@Alex draft",
      draftMentions: mentions,
      queue: [
        queued("mention-send", {
          text: "@Alex queued",
          mentions,
          sendRunId: "mention-run",
          sendState: "waiting-reconnect",
        }),
      ],
      updatedAt: 1,
    };
    writeStoredOutboxStore(sessionStorage, target, store);
    mentions[0]!.profileId = "later-selection";
  } else {
    seedSource(target, 4, {
      [scopeKey]: {
        queue: [
          {
            ...queued("corrupt-mention", {
              text: "@Alex review",
              sendState: "waiting-reconnect",
            }),
            mentions: invalid,
          },
        ],
        updatedAt: 1,
      },
    });
  }
  const restored = readStore().sessions[scopeKey];
  if (invalid === undefined) {
    expect(restored).toMatchObject({
      draft: "@Alex draft",
      draftMentions: [mention()],
      queue: [
        {
          text: "@Alex queued",
          mentions: [mention()],
          sendRunId: "mention-run",
          sendState: "waiting-reconnect",
        },
      ],
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

it("clears every retained projection after an external storage clear", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeStoredChatOutboxChanges(listener);
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
  unsubscribe();
  for (const storageGateway of gatewayUrls) {
    expect(createStoredChatOutboxReader().read(ownedState(storageGateway)).total).toBe(0);
  }
  expect(listener).toHaveBeenCalledOnce();
});

it.each(["captured", "quota", "batch"] as const)(
  "retires the captured scope while preserving other drafts (%s)",
  (scenario) => {
    const captured = scenario === "captured";
    const failed = scenario === "quota";
    const oldKey = captured ? "agent:main:main" : failed ? "global" : "older";
    const agentId = failed ? "work" : "main";
    const scope = storedChatOutboxScopeKey({ sessionKey: oldKey, agentId });
    const other = storedChatOutboxScopeKey({
      sessionKey: captured ? "agent:main:current" : "newer",
    });
    const replacement = {
      draft: captured ? "new target" : "replacement",
      draftRevision: captured ? 11 : 1_000,
      updatedAt: captured ? 11 : 1_000,
    };
    seedStore(target, {
      [scope]: {
        draft: "retire me",
        draftRevision: 10,
        ...(captured ? {} : { queue: [queued("queued")] }),
        updatedAt: 10,
      },
      ...(failed ? {} : { [other]: replacement }),
    });
    const before = sessionStorage.getItem(target.key);
    const write = vi.spyOn(sessionStorage, "setItem");
    if (failed) {
      write.mockImplementationOnce(quotaExceeded);
    }
    const listener = vi.fn();
    cleanups.push(subscribeStoredChatOutboxChanges(listener));
    const cutoff = captured || failed ? 20 : 100;
    const result = retireStoredComposerDrafts(
      {
        settings: { gatewayUrl: target.gatewayOwner },
        ...(captured
          ? { agentsList: { defaultId: "main", mainKey: "current", scope: "per-sender" } }
          : {}),
      },
      [
        { key: oldKey, agentId, retireBeforeRevision: cutoff },
        ...(!captured && !failed
          ? [{ key: "newer", agentId: "main", retireBeforeRevision: cutoff }]
          : []),
      ],
    );
    expect(result.storageFailed).toBe(failed);
    expect(write).toHaveBeenCalledOnce();
    if (failed) {
      expect(result).toEqual({
        gatewayOwner: target.gatewayOwner,
        retirements: [
          {
            scope: { sessionKey: oldKey, agentId },
            minimumRevision: expect.any(Number),
            retireBeforeRevision: cutoff,
          },
        ],
        storageFailed: true,
      });
      expect(sessionStorage.getItem(target.key)).toBe(before);
    } else {
      const stored = readStore();
      expect(stored.sessions[scope]).toEqual({
        draftRevision: expect.any(Number),
        updatedAt: expect.any(Number),
      });
      expect(stored.sessions[scope]?.draftRevision).toBeGreaterThan(cutoff);
      expect(stored.sessions[other]).toEqual(replacement);
      expect(listener).toHaveBeenCalledOnce();
    }
  },
);

it.each([
  [{ hello: null }, "thread-draft\u0000agent:main", ["thread-draft"], ["agent:main:thread-draft"]],
  [{ hello: null }, "main\u0000agent:@unresolved", ["main"], ["agent:main:main"]],
  [
    { assistantAgentId: "previous", agentsList: { defaultId: "work", mainKey: "workspace" } },
    "agent:work:workspace\u0000agent:work",
    ["main", "workspace", "agent:work:main", "agent:work:workspace"],
    ["agent:previous:main"],
  ],
  [
    { agentsList: { defaultId: "main", mainKey: "workspace" } },
    "agent:work:workspace\u0000agent:work",
    ["agent:work:main", "agent:work:workspace"],
    ["main", "workspace", "agent:main:workspace"],
  ],
  [
    selectedWork,
    "global\u0000agent:work",
    ["global", "agent:work:main", "agent:work:workspace"],
    ["main", "workspace", "agent:main:main", "agent:work:global"],
  ],
  [
    selectedWork,
    "global\u0000agent:main",
    ["main", "workspace", "agent:main:main"],
    ["global", "agent:work:main"],
  ],
  [
    selectedWork,
    "agent:work:global\u0000agent:work",
    ["agent:work:global"],
    ["global", "main", "agent:work:main"],
  ],
  [
    { agentsList: { defaultId: "main", mainKey: "main" } },
    "agent:work:matrix:channel:!Room:Server\u0000agent:work",
    ["agent:work:matrix:channel:!Room:Server", "Agent:Work:MATRIX:CHANNEL:!Room:Server"],
    ["agent:work:matrix:channel:!room:server"],
  ],
] as const)("queries draft and attention snapshots %#", (state, storedKey, present, absent) => {
  seedStore(storageTargetForGateway(gatewayUrl, "summary-owner"), {
    [storedKey]: {
      draft: "finish this message",
      draftRevision: 3,
      queue: ownedQueue(gatewayUrl, [
        { id: "failed", text: "retry this message", createdAt: 3, sendState: "failed" },
      ]),
      updatedAt: 3,
    },
    "thread-empty\u0000agent:main": { draftRevision: 2, updatedAt: 2 },
    "thread-queue\u0000agent:main": {
      queue: ownedQueue(gatewayUrl, [{ id: "queued", text: "queued", createdAt: 1 }]),
      updatedAt: 1,
    },
  });
  const summary = createStoredChatOutboxReader().read({ ...state, ...ownedState(gatewayUrl) });
  const read = vi.spyOn(sessionStorage, "getItem");
  sessionStorage.clear();
  expect(summary.total).toBe(2);
  for (const sessionKey of present) {
    expect(summary.hasSessionDraft(sessionKey), sessionKey).toBe(true);
    expect(summary.attentionCountForSession(sessionKey), sessionKey).toBe(1);
  }
  for (const sessionKey of [...absent, "thread-empty", "thread-queue", "absent"]) {
    expect(summary.hasSessionDraft(sessionKey), sessionKey).toBe(false);
    expect(summary.attentionCountForSession(sessionKey), sessionKey).toBe(0);
  }
  expect(read).not.toHaveBeenCalled();
});

it("bridges matching storage events until the last subscriber leaves", () => {
  const addEventListener = vi.spyOn(window, "addEventListener");
  const removeEventListener = vi.spyOn(window, "removeEventListener");
  const firstListener = vi.fn();
  const secondListener = vi.fn();
  const unsubscribeFirst = subscribeStoredChatOutboxChanges(firstListener);
  const unsubscribeSecond = subscribeStoredChatOutboxChanges(secondListener);
  const storageListeners = addEventListener.mock.calls
    .filter(([type]) => type === "storage")
    .map(([, listener]) => listener);
  expect(storageListeners).toEqual([expect.any(Function)]);
  for (const [key, count] of [
    ["openclaw.control.chatComposer.v4:gateway", 1],
    ["openclaw.control.settings.v1", 1],
    ["openclaw.control.chatComposer.v1:gateway", 2],
  ] as const) {
    window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(firstListener).toHaveBeenCalledTimes(count);
    expect(secondListener).toHaveBeenCalledTimes(count);
  }
  unsubscribeFirst();
  expect(removeEventListener.mock.calls.filter(([type]) => type === "storage")).toEqual([]);
  unsubscribeSecond();
  expect(
    removeEventListener.mock.calls
      .filter(([type]) => type === "storage")
      .map(([, listener]) => listener),
  ).toEqual(storageListeners);
});

it("rejects a store owned by another gateway", () => {
  seedStore(
    { ...target, gatewayOwner: "ws://other.test/control" },
    {
      "global\u0000agent:work": storedSession({ queue: [queued("queued")] }),
    },
  );
  expect(
    createStoredChatOutboxReader().read({
      client: null,
      connected: false,
      settings: { gatewayUrl },
      agentsList: { defaultId: "work", mainKey: "workspace" },
    }).total,
  ).toBe(0);
  expect(storedJson(target.key).gatewayOwner).toBe("ws://other.test/control");
});

it("projects metadata-only badges and counts distinct operator-review rows", () => {
  const restoredSendStates = [
    undefined,
    "waiting-idle",
    "executing-command",
    "sending",
    "waiting-reconnect",
  ] as const;
  seedStore(storageTargetForGateway(gatewayUrl, "summary-owner"), {
    "agent:main:a\u0000agent:main": { draft: "private draft", updatedAt: 1 },
    "agent:work:b\u0000agent:work": {
      queue: ownedQueue(gatewayUrl, [
        ...restoredSendStates.map((sendState, createdAt) =>
          queued(`healthy-${createdAt}`, { createdAt, sendState }),
        ),
        queued("held", { createdAt: 9, sendState: "held" }),
        queued("failed", { createdAt: 10, sendState: "failed" }),
        queued("failed", { text: "duplicate", createdAt: 11, sendState: "failed" }),
        queued("unconfirmed", { createdAt: 12, sendState: "unconfirmed" }),
        queued("unconfirmed", { text: "duplicate", createdAt: 13, sendState: "unconfirmed" }),
        queued("other-owner", {
          createdAt: 14,
          sendState: "failed",
          attachmentPayload: { key: "bundle", recoveryScope: "other-owner", tabId: "tab" },
        }),
      ]),
      updatedAt: 13,
    },
    "thread-b\u0000agent:main": {
      queue: ownedQueue(gatewayUrl, [
        queued("unconfirmed", { createdAt: 14, sendState: "unconfirmed" }),
      ]),
      updatedAt: 14,
    },
  });
  const summary = createStoredChatOutboxReader().read(ownedState(gatewayUrl));
  expect(summary.total).toBe(9);
  expect(summary.sessions).toEqual([
    badge("agent:main:a", "main", true),
    badge("agent:work:b", "work", false, 4),
    badge("thread-b", undefined, false, 1),
  ]);
  expect(summary.attentionCountForSession("agent:work:b")).toBe(4);
  expect(summary.attentionCountForSession("thread-b")).toBe(1);
  expect(summary.attentionCountForSession("absent")).toBe(0);
});

it("derives badges and replay from the same migrated durable queue", () => {
  const legacyKey = `openclaw.control.chatComposer.v1:${encodeURIComponent(gatewayUrl)}`;
  seedSource(storageTargetForGateway(gatewayUrl), 1, {
    "main\u0000agent:previous": {
      queue: [queued("removed"), queued("shared", { text: "older", createdAt: 2 })],
      removedQueueItemIds: ["removed"],
      updatedAt: 2,
    },
    "global\u0000agent:work": {
      queue: [queued("shared", { text: "newer", createdAt: 3 })],
      updatedAt: 3,
    },
  });
  const state = {
    ...ownedState(gatewayUrl),
    assistantAgentId: "work",
    agentsList: { defaultId: "work", mainKey: "main" },
  };
  // Legacy migration retains unowned bytes; explicit review admits the selected row.
  expect(createStoredChatOutboxReader().read(state).total).toBe(0);
  const recovery = readChatOutboxRecovery(state);
  expect(
    recovery.entries.find((entry) => entry.sourceScopeKey === "main\u0000agent:previous")?.session
      .queue,
  ).toMatchObject([{ id: "shared", text: "older" }]);
  const entry = recovery.entries.find(
    (candidate) => candidate.sourceScopeKey === "global\u0000agent:work",
  )!;
  const destination = captureChatOutboxRecoveryDestination(state, {
    sessionKey: "global",
    agentId: "work",
  })!;
  expect(restoreChatOutboxRecovery(state, entry, destination)).toBe("restored");
  const summary = createStoredChatOutboxReader().read(state);
  const outboxes = listStoredChatOutboxes(state);
  expect(summary.total).toBe(1);
  expect(outboxes[0]?.queue).toEqual([
    queued("shared", {
      text: "newer",
      createdAt: 3,
      sessionKey: "global",
      agentId: "work",
      storageScope: outboxStorageScope(state),
      sendState: "failed",
      sendError: "Recovered message. Review this destination and retry only if it did not arrive.",
    }),
  ]);
  expect(sessionStorage.getItem(legacyKey)).toBeNull();
});
