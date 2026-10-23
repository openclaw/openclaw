// @vitest-environment node
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { outboxStorageScope as scopeFor } from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination as recoveryDestination,
  readChatOutboxRecovery as readRecovery,
  restoreChatOutboxRecovery as restoreRecovery,
} from "../../lib/chat/outbox-recovery.ts";
import {
  createStoredChatOutboxReader,
  listStoredChatOutboxes as listOutboxes,
} from "../../lib/chat/outbox-store-projection.ts";
import {
  captureChatOutboxAdmission,
  storageTargetForComposer,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity as resolveIdentity } from "../../lib/sessions/session-key.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  loadChatComposerState as load,
  persistChatComposerState as persist,
} from "./composer-draft-storage.ts";
import {
  legacyStorageKeyForGateway as legacyKey,
  createState,
  reconnectItem,
  legacyReconnectItem,
  admitItem,
  reviewLegacyItem,
  fillOutboxes,
  releaseOutbox,
  startPersistence,
  reloadStorage,
} from "./composer-persistence.test-support.ts";
import { ChatComposerPersistence } from "./composer-persistence.ts";
import {
  admitStoredChatComposerQueueItemResult,
  updateStoredChatComposerQueueItems as updateItems,
} from "./composer-queue-persistence.ts";

type ComposerState = ReturnType<typeof createState>;

function pane(chatMessage = ""): [ComposerState, ChatComposerPersistence] {
  const state = createState({ chatMessage });
  return [state, startPersistence(state)];
}
function savedState(overrides: Partial<ComposerState> = {}) {
  const state = createState({ chatMessage: "saved draft", ...overrides });
  expect(persist(state)).toBe(true);
  return state;
}
const replaceItem = (
  state: ComposerState,
  expected: ChatQueueItem,
  next: ChatQueueItem,
  agentId?: string,
) => updateItems(state, state.sessionKey, [{ expected, next }], agentId);
function seedSessions(
  sessions: Record<string, unknown>,
  version = 1,
  gatewayUrl = "ws://gateway.test/control",
) {
  const target =
    version === 4
      ? storageTargetForComposer(createState({ settings: { gatewayUrl } }))
      : storageTargetForGateway(gatewayUrl);
  const key = version === 1 ? target.legacyKey : target.key.replace(".v4:", `.v${version}:`);
  const owner = version === 1 ? {} : { gatewayOwner: gatewayUrl, recovery: {} };
  sessionStorage.setItem(key, JSON.stringify({ version, ...owner, sessions }));
}

function seedSession(session: Record<string, unknown>, version = 1, key = "agent:lily:main") {
  seedSessions({ [`${key}\u0000agent:lily`]: { updatedAt: 1, ...session } }, version);
}

const snapshot = (state: ComposerState, key = state.sessionKey) => load(state, key).snapshot;
const revision = (state: ComposerState) => load(state, state.sessionKey).revisions.latestAttempt;

const readStored = (state: ComposerState) =>
  JSON.parse(sessionStorage.getItem(storageTargetForComposer(state).key)!);
const storedRow = (state: ComposerState) =>
  readStored(state).sessions[`${state.sessionKey}\u0000agent:lily`];
function quotaFailure() {
  throw new DOMException("quota exceeded", "QuotaExceededError");
}

const expectPersisted = (persistence: ChatComposerPersistence) =>
  expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });

function edit(state: ComposerState, persistence: ChatComposerPersistence, text: string) {
  state.chatMessage = text;
  persistence.schedule();
}

const expectDraft = (state: ComposerState, draft: string, queue: ChatQueueItem[] = []) =>
  expect(snapshot(state)).toEqual({ draft, queue });
function roundtripQueue(state: ComposerState, id: string) {
  const queued = reconnectItem(id, 1);
  expect(admitItem(state, queued)).toBe(true);
  expect(updateItems(state, state.sessionKey, [{ expected: queued, next: null }])).toBe(true);
}

function outbox(items: ChatQueueItem | ChatQueueItem[], sessionKey: string, agentId?: string) {
  const scope = { sessionKey, ...(agentId ? { agentId } : {}) };
  const queue = Array.isArray(items) ? items : [items];
  return { ...scope, queue: queue.map((item) => Object.assign({}, item, scope)) };
}
function heldItem(state: ComposerState, fields: Partial<ChatQueueItem> = {}): ChatQueueItem {
  return {
    id: "submitted",
    storageScope: scopeFor(state),
    text: "Submitted private message",
    createdAt: 1,
    sendState: "held",
    ...fields,
  };
}
const privateMentions = [{ profileId: "alex", start: 0, end: 5 }];
const privateGoal = { action: "start" as const, sessionId: "private-session" };
const recoveredError =
  "Recovered message. Review this destination and retry only if it did not arrive.";
function reviewed(state: ComposerState, item: ChatQueueItem, sendError = recoveredError) {
  return { ...item, storageScope: scopeFor(state), sendState: "failed" as const, sendError };
}
const workAgents = { defaultId: "work", mainKey: "main", scope: "global" };
const workState = (fields: Partial<ComposerState> = {}) =>
  createState({
    agentsList: workAgents,
    assistantAgentId: "work",
    sessionKey: "global",
    ...fields,
  });

function fillDrafts(prefix: string, count: number, chatMessage: string) {
  for (let index = 0; index < count; index += 1) {
    savedState({ sessionKey: `agent:${prefix}-${index}:thread`, chatMessage });
  }
}

function failedWrite(persistence: ChatComposerPersistence, expectedDraftRevision?: number) {
  const result = persistence.persistForRouteSwitchResult();
  expect(result.status).toBe("storage-failed");
  if (result.status !== "storage-failed") {
    throw new Error("Expected a retryable storage failure");
  }
  if (expectedDraftRevision !== undefined) {
    expect(result.expectedDraftRevision).toBe(expectedDraftRevision);
  }
  return result;
}

function retryDraft(
  state: ComposerState,
  { draftRevision, expectedDraftRevision }: ReturnType<typeof failedWrite>,
) {
  return persist(state, state.sessionKey, { draftRevision, expectedDraftRevision });
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("recovers browser storage after an unavailable initial open", async () => {
  vi.resetModules();
  const { openControlUiDatabase } = await import("../../lib/chat/control-ui-database.runtime.ts");
  vi.stubGlobal("indexedDB", undefined);
  await expect(openControlUiDatabase()).rejects.toThrow("IndexedDB is unavailable");
  vi.stubGlobal("indexedDB", new IDBFactory());
  const database = await openControlUiDatabase();
  try {
    expect(database.objectStoreNames.contains("outboxPayloads")).toBe(true);
  } finally {
    database.close();
  }
});

it("restores selected recipients and gives same-text recipient changes their own revision", () => {
  const first = [{ profileId: "alex-one", start: 0, end: 5 }];
  const second = [{ profileId: "alex-two", start: 0, end: 5 }];
  const state = createState({ chatMessage: "@Alex", chatMentions: first });
  expect(persist(state, state.sessionKey, { draftRevision: 10 })).toBe(true);
  roundtripQueue(state, "keep-draft-mentions");
  const restored = createState();
  expect(new ChatComposerPersistence(() => restored).restore()).toBe(true);
  expect(restored.chatMentions).toEqual(first);
  expect(persist(state, state.sessionKey, { draftRevision: 10, mentions: second })).toBe(false);

  const persistence = startPersistence(state);
  state.chatMentions = second;
  persistence.schedule();
  persistence.persistChangedState();
  expect(snapshot(state)?.mentions).toEqual(second);
  expect(revision(state)).toBeGreaterThan(10);
  state.chatMentions = [];
  persistence.schedule();
  persistence.stop();
  expectDraft(state, "@Alex");
});

it("restores objective-edit mode with its literal draft and exact target", () => {
  const goalMode = {
    action: "edit" as const,
    sessionId: "session-a",
    goalId: "goal-a",
    previousDraft: "Prior conversation draft",
  };
  const state = savedState({
    chatMessage: "  /goal clear\n  literal objective ",
    chatGoalDraftMode: goalMode,
    agentsList: { defaultId: "lily", mainKey: "main" },
  });
  const restored = createState();
  expect(new ChatComposerPersistence(() => restored).restore()).toBe(true);
  expect(restored).toMatchObject({ chatMessage: state.chatMessage, chatGoalDraftMode: goalMode });
  expect(snapshot(state, "agent:lily:other")).toBeNull();
  roundtripQueue(state, "other-message");
  expect(snapshot(state)?.goalMode).toEqual(goalMode);
});

it("normalizes an existing whitespace-only stored draft during restore", () => {
  const state = createState();
  seedSession({ draft: "  \n  ", draftRevision: 1 }, 4);

  expect(new ChatComposerPersistence(() => state).restore()).toBe(false);
  expect(state.chatMessage).toBe("");
});

it("reviews legacy steer rows as generic mode-bearing sends and never rewrites old fields", () => {
  const state = createState({ agentsList: { defaultId: "lily", mainKey: "main" } });
  const storageKey = storageTargetForComposer(state).key;
  const legacy = {
    ...legacyReconnectItem("steer-reload", 1),
    kind: "steered",
    sendRunId: "steer-request",
    sendState: "steering",
    steerTargetRunId: "active-run",
  };
  seedSession({ queue: [legacy] }, 2);

  const restored = reviewLegacyItem(state, "steer-reload");
  expect(restored).toMatchObject({
    id: "steer-reload",
    storageScope: scopeFor(state),
    queueMode: "steer",
    sendRunId: "steer-request",
    sendState: "unconfirmed",
  });
  expect(restored).not.toHaveProperty("kind");
  expect(restored).not.toHaveProperty("steerTargetRunId");

  expect(replaceItem(state, restored!, { ...restored!, text: "updated" }, restored?.agentId)).toBe(
    true,
  );
  const written = sessionStorage.getItem(storageKey) ?? "";
  expect(written).toContain('"queueMode":"steer"');
  expect(written).not.toMatch(/"kind":"steered"|steerTargetRunId|"sendState":"steering"/);
});

it("does not erase another split pane draft when its own draft is unchanged", () => {
  const [, untouchedPersistence] = pane();

  const editedPane = savedState({ chatMessage: "draft from the other pane" });

  expectPersisted(untouchedPersistence);
  expect(snapshot(editedPane)?.draft).toBe("draft from the other pane");
});

it("keeps the later edit when split pane timers flush in natural order", () => {
  vi.useFakeTimers();
  const [firstPane, firstPersistence] = pane();
  const [secondPane, secondPersistence] = pane();

  edit(firstPane, firstPersistence, "first draft");
  vi.advanceTimersByTime(10);
  edit(secondPane, secondPersistence, "later draft");

  vi.advanceTimersByTime(190);
  expect(snapshot(firstPane)?.draft).toBe("first draft");

  vi.advanceTimersByTime(10);
  expect(snapshot(secondPane)?.draft).toBe("later draft");
});

it("fences an older pane after a newer clear and allows a subsequent edit", () => {
  vi.useFakeTimers();
  const initial = savedState();
  const [olderPane, olderPersistence] = pane("saved draft");
  const [clearingPane, clearingPersistence] = pane("saved draft");

  edit(olderPane, olderPersistence, "stale replacement");
  edit(clearingPane, clearingPersistence, "");
  expectPersisted(clearingPersistence);

  vi.advanceTimersByTime(200);

  expect(snapshot(initial)).toBeNull();
  expect(olderPersistence.persistForRouteSwitchResult().status).toBe("conflict");
  edit(olderPane, olderPersistence, "newest draft after conflict");
  vi.advanceTimersByTime(200);
  expect(snapshot(olderPane)?.draft).toBe("newest draft after conflict");
});

it("persists a delayed global draft to the agent scope captured when typed", () => {
  const state = createState({ assistantAgentId: "alpha", chatMessage: "", sessionKey: "global" });
  const persistence = startPersistence(state);
  edit(state, persistence, "alpha draft");

  const beta = savedState({
    assistantAgentId: "beta",
    chatMessage: "beta draft",
    sessionKey: "global",
  });
  state.assistantAgentId = "beta";

  expect(persistence.scopeForRouteSwitch()).toEqual({ sessionKey: "global", agentId: "alpha" });
  expectPersisted(persistence);
  expect(persistence.scopeForRouteSwitch()).toEqual({ sessionKey: "global", agentId: "alpha" });
  expectPersisted(persistence);
  expect(load({ ...state, assistantAgentId: "alpha" }, "global").snapshot?.draft).toBe(
    "alpha draft",
  );
  expect(snapshot(beta, "global")?.draft).toBe("beta draft");
});

it("rejects conflicting admission of an existing item id", () => {
  const item = reconnectItem("same-id", 1);
  expect(admitItem(createState(), item)).toBe(true);
  expect(admitItem(createState(), { ...item, text: "different payload" })).toBe(false);
});

it("rejects stale updates and deletes after an attachment payload replacement", () => {
  const state = savedState({
    chatMessage: "keep this draft",
    client: { recoveryScope: "versioned-owner", recoveryScopeReady: true },
  });
  const reference = {
    key: "original-payload",
    recoveryScope: "versioned-owner",
    tabId: "versioned-tab",
  };
  const original: ChatQueueItem = {
    ...reconnectItem("versioned", 1, state),
    attachments: [{ id: "versioned-file", mimeType: "image/png", sizeBytes: 3 }],
    attachmentPayload: reference,
  };
  const successor = { ...original, attachmentPayload: { ...reference, key: "replacement" } };
  expect(admitItem(state, original)).toBe(true);
  expect(replaceItem(state, original, successor)).toBe(true);
  expect(replaceItem(state, original, { ...original, sendAttempts: 2 })).toBe(false);
  expect(updateItems(state, state.sessionKey, [{ expected: original, next: null }])).toBe(false);
  expect(snapshot(state)?.queue[0]).toMatchObject(successor);
  expect(updateItems(state, state.sessionKey, [{ expected: successor, next: null }])).toBe(true);
  expectDraft(state, "keep this draft");
});

it("keeps unresolved bare main and raw global independent until their owners resolve", () => {
  const offlineMain = createState({ sessionKey: "main" });
  const offlineGlobal = createState({ sessionKey: "global" });
  const mainItem = reconnectItem("unresolved-main", 1);
  const globalItem = reconnectItem("unresolved-global", 2);
  expect(admitItem(offlineMain, mainItem)).toBe(true);
  expect(admitItem(offlineGlobal, globalItem)).toBe(true);
  expect(listOutboxes(offlineMain)).toEqual([
    outbox(mainItem, "main"),
    outbox(globalItem, "global"),
  ]);
  const resolved = workState({ assistantAgentId: "alpha" });
  const mainBox = outbox(mainItem, "global", "work");
  const globalBox = outbox(globalItem, "global", "alpha");
  expect(listOutboxes(resolved)).toEqual([mainBox, globalBox]);
  const attemptedMain = { ...mainBox.queue[0]!, sendAttempts: 1 };
  const attemptedGlobal = { ...globalBox.queue[0]!, sendAttempts: 1 };
  expect(replaceItem(resolved, mainBox.queue[0]!, attemptedMain)).toBe(true);
  expect(replaceItem(resolved, globalBox.queue[0]!, attemptedGlobal)).toBe(true);
  expect(updateItems(resolved, "global", [{ expected: attemptedMain, next: null }])).toBe(true);
  expect(listOutboxes(resolved)).toEqual([outbox(attemptedGlobal, "global", "alpha")]);
  expect(updateItems(resolved, "global", [{ expected: attemptedGlobal, next: null }])).toBe(true);
  expect(listOutboxes(resolved)).toEqual([]);
});

it("retains ambiguous shipped main rows for explicit destination confirmation", () => {
  const item = legacyReconnectItem("legacy-main", 1);
  seedSessions({ "main\u0000agent:previous": { queue: [item], updatedAt: 1 } });
  const state = createState({ agentsList: { defaultId: "work", mainKey: "main" } });
  expect(listOutboxes(state)).toEqual([]);
  expect(readRecovery(state).entries[0]?.session.queue).toEqual([item]);
});

it("reviews shipped selected-agent opaque rows without passively adopting either draft", () => {
  const sessionKey = "matrix:group:RoomCase";
  const first = legacyReconnectItem("legacy-work", 1);
  const second = legacyReconnectItem("legacy-alpha", 2);
  seedSessions({
    [sessionKey + "\u0000agent:work"]: { draft: "older draft", queue: [first], updatedAt: 1 },
    [sessionKey + "\u0000agent:alpha"]: { draft: "newer draft", queue: [second], updatedAt: 2 },
  });
  const state = createState({
    assistantAgentId: "alpha",
    sessionKey,
    agentsList: { defaultId: "alpha", mainKey: "main" },
  });
  const restored = reviewLegacyItem(state, first.id);
  const expected = reviewed(state, first);
  expect(listOutboxes(state)).toEqual([outbox(expected, sessionKey)]);
  expectDraft(state, "older draft", outbox(expected, sessionKey).queue);

  const attempted = { ...restored, sendAttempts: 1 };
  expect(replaceItem(state, restored, attempted)).toBe(true);
  expect(updateItems(state, sessionKey, [{ expected: attempted, next: null }])).toBe(true);
  expectDraft(state, "older draft");
  expect(readRecovery(state).entries.map((entry) => entry.session)).toMatchObject([
    { draft: "newer draft", queue: [second] },
  ]);
  const stored = readStored(state);
  expect(Object.keys(stored.sessions)).toEqual([sessionKey + "\u0000agent:main"]);
});

it("keeps readable migrated composer state when the migration write fails", () => {
  const unresolved = savedState({ chatMessage: "unresolved draft", sessionKey: "main" });
  const item = reconnectItem("unresolved-with-quota", 1);
  expect(admitItem(unresolved, item, "main")).toBe(true);
  vi.spyOn(sessionStorage, "setItem").mockImplementation(quotaFailure);

  const resolved = workState();
  expectDraft(resolved, "unresolved draft", outbox(item, "global", "work").queue);
});

it("reviews full v1 main and global queues while consuming legacy tombstones", () => {
  const globalQueue = Array.from({ length: 50 }, (_, i) => legacyReconnectItem(`global-${i}`, i));
  const mainQueue = Array.from({ length: 50 }, (_, i) => legacyReconnectItem(`main-${i}`, i + 50));
  mainQueue[0] = {
    ...legacyReconnectItem("main-0", 50),
    sendState: "failed",
    sendError: "RangeError: Maximum call stack size exceeded",
    attachments: [
      {
        id: "legacy-attachment",
        mimeType: "image/png",
        fileName: "legacy.png",
        dataUrl: "data:image/png;base64,AAA",
      },
    ],
  };
  const mainKey = "agent:work:main";
  seedSessions({
    "global\u0000agent:work": { queue: globalQueue, updatedAt: 2 },
    "agent:work:notes\u0000agent:work": { draft: "draft only", updatedAt: 1 },
    [mainKey + "\u0000agent:work"]: {
      draft: "legacy draft",
      queue: [legacyReconnectItem("removed", 100), ...mainQueue],
      removedQueueItemIds: ["removed"],
      updatedAt: 1,
    },
  });
  const state = createState({
    assistantAgentId: "work",
    sessionKey: mainKey,
    agentsList: { defaultId: "work", mainKey: "main", scope: "per-sender" },
  });
  for (const sessionKey of ["global", mainKey, "agent:work:notes"]) {
    expect(snapshot(state, sessionKey)).toBeNull();
  }
  expect(listOutboxes(state)).toEqual([]);
  const entries = readRecovery(state).entries;
  expect(entries).toHaveLength(3);
  expect(sessionStorage.getItem(storageTargetForComposer(state).key)).toBeNull();
  for (const [sessionKey, queue] of [
    ["global", globalQueue],
    [mainKey, mainQueue],
    ["agent:work:notes", undefined],
  ] as const) {
    const entry = entries.find(
      (candidate) => candidate.sourceScopeKey === sessionKey + "\u0000agent:work",
    );
    expect(entry).toBeDefined();
    if (queue) {
      expect(entry?.session.queue).toEqual(outbox(queue, sessionKey, "work").queue);
    }
    const destination = recoveryDestination(state, resolveIdentity(state, sessionKey, "work"));
    expect(destination).not.toBeNull();
    expect(restoreRecovery(state, entry!, destination!)).toBe("restored");
  }
  const reviewedItem = (item: ChatQueueItem) => reviewed(state, item, item.sendError);
  expect(snapshot(state, "agent:work:notes")?.draft).toBe("draft only");
  expectDraft(state, "legacy draft", outbox(mainQueue.map(reviewedItem), mainKey, "work").queue);
  expect(snapshot(state, "global")?.queue).toEqual(
    outbox(globalQueue.map(reviewedItem), "global", "work").queue,
  );
  expect(
    listOutboxes(state)
      .flatMap((box) => box.queue)
      .map((item) => item.id),
  ).toEqual([...globalQueue, ...mainQueue].map((item) => item.id));
  expect(readRecovery(state).entries).toEqual([]);
  state.chatMessage = "updated draft";
  expect(persist(state)).toBe(true);
  expect(sessionStorage.getItem(storageTargetForComposer(state).key)).not.toContain(
    "removedQueueItemIds",
  );
  expect(sessionStorage.getItem(legacyKey(state.settings?.gatewayUrl))).toBeNull();
});

it.each([
  ["sending", "waiting-reconnect", undefined, undefined],
  [
    "waiting-model",
    "failed",
    "previous attempt failed",
    "Chat settings update was interrupted. Review and retry when ready.",
  ],
] as const)(
  "normalizes %s before durable replay",
  (sendState, restoredState, sendError, restoredError) => {
    const state = createState();
    const item: ChatQueueItem = {
      ...reconnectItem("interrupted", 1),
      sendState,
      ...(sendError ? { sendError } : {}),
    };
    expect(admitItem(state, item)).toBe(true);
    expect(load(state, state.sessionKey).snapshot?.queue).toEqual(
      outbox(
        {
          ...item,
          sendState: restoredState,
          ...(restoredError ? { sendError: restoredError } : {}),
        },
        state.sessionKey,
        "lily",
      ).queue,
    );
  },
);

it("isolates long same-prefix gateways in owner-tagged v4 buckets", () => {
  const sharedPrefix = `wss://gateway.test/${"a".repeat(260)}`;
  const gateways = ["first", "second"].map((route, index) => {
    const state = createState({
      chatMessage: `${route} gateway draft`,
      settings: { gatewayUrl: `${sharedPrefix}?route=${route}` },
    });
    return { route, state, item: reconnectItem(`${route}-long-gateway`, index + 1, state) };
  });
  expect(legacyKey(gateways[0]!.state.settings?.gatewayUrl)).toBe(
    legacyKey(gateways[1]!.state.settings?.gatewayUrl),
  );
  expect(storageTargetForComposer(gateways[0]!.state).key).not.toBe(
    storageTargetForComposer(gateways[1]!.state).key,
  );
  for (const { state, item } of gateways) {
    expect(persist(state)).toBe(true);
    expect(admitItem(state, item)).toBe(true);
  }
  for (const { route, state, item } of gateways) {
    expectDraft(state, `${route} gateway draft`, outbox(item, state.sessionKey, "lily").queue);
    expect(readStored(state)).toMatchObject({
      gatewayOwner: state.settings?.gatewayUrl,
      version: 4,
    });
  }
});

it("does not replay an exact-240 legacy key to a longer same-prefix gateway", () => {
  const prefix = "wss://gateway.test/";
  const exactGatewayUrl = `${prefix}${"a".repeat(240 - encodeURIComponent(prefix).length)}`;
  const longerGatewayUrl = `${exactGatewayUrl}b`;
  expect(encodeURIComponent(exactGatewayUrl)).toHaveLength(240);
  expect(legacyKey(exactGatewayUrl)).toBe(legacyKey(longerGatewayUrl));
  const item = legacyReconnectItem("ambiguous-legacy-owner", 1);
  seedSessions(
    { "agent:lily:main\u0000agent:lily": { queue: [item], updatedAt: 1 } },
    1,
    exactGatewayUrl,
  );

  for (const gatewayUrl of [exactGatewayUrl, longerGatewayUrl]) {
    const state = createState({ settings: { gatewayUrl } });
    expect(snapshot(state)).toBeNull();
    expect(listOutboxes(state)).toEqual([]);
    expect(sessionStorage.getItem(storageTargetForComposer(state).key)).toBeNull();
    expect(readRecovery(state).entries).toEqual([]);
    expect(sessionStorage.getItem(legacyKey(gatewayUrl))).toContain(item.id);
  }
});

it("evicts draft-only sessions before rejecting an outbox session overflow", () => {
  fillOutboxes("queued", 19);
  const draftSessionKey = "agent:lily:draft-only";
  expect(
    persist(createState({ chatMessage: "evict this draft first", sessionKey: draftSessionKey })),
  ).toBe(true);

  const twentiethSessionKey = "agent:lily:queued:19";
  expect(
    admitItem(createState({ sessionKey: twentiethSessionKey }), reconnectItem("queued-19", 19)),
  ).toBe(true);
  expect(load(createState(), draftSessionKey).snapshot).toBeNull();
  expect(listOutboxes(createState())).toHaveLength(20);

  const rejectedDraft = createState({ sessionKey: "agent:lily:rejected-draft" });
  const rejectedPersistence = startPersistence(rejectedDraft);
  edit(rejectedDraft, rejectedPersistence, "keep retrying this draft");
  failedWrite(rejectedPersistence, 0);
  expect(snapshot(rejectedDraft)).toBeNull();

  const overflowSessionKey = "agent:lily:queued:20";
  expect(
    admitItem(createState({ sessionKey: overflowSessionKey }), reconnectItem("queued-20", 20)),
  ).toBe(false);
  const outboxes = listOutboxes(createState());
  expect(outboxes).toHaveLength(20);
  expect(outboxes.some((box) => box.sessionKey === overflowSessionKey)).toBe(false);
  expect(outboxes.some((box) => box.sessionKey === "agent:lily:queued:0")).toBe(true);
});

it("retains an unresolved custom-main clear through draft and outbox capacity pressure", () => {
  const resolved = savedState({
    assistantAgentId: "work",
    chatMessage: "stale resolved draft",
    sessionKey: "global",
  });
  const queued = reconnectItem("resolved-work-queue", 1);
  expect(admitItem(resolved, queued)).toBe(true);

  const offline = savedState({ sessionKey: "workspace", chatMessage: "stale resolved draft" });
  expect(new ChatComposerPersistence(() => offline).restore()).toBe(true);
  expect(offline.chatMessage).toBe("stale resolved draft");
  const persistence = startPersistence(offline);
  edit(offline, persistence, "");
  expectPersisted(persistence);

  fillDrafts("newer-draft", 21, "newer ordinary draft");

  fillOutboxes("clear-capacity", 19);
  expect(listOutboxes(offline)).toHaveLength(20);

  fillDrafts("newer-clear", 25, "");
  reloadStorage(offline);

  expect(load(createState({ sessionKey: "workspace" }), "workspace").snapshot).toBeNull();
  const reconnected = workState({
    agentsList: { defaultId: "work", mainKey: "workspace", scope: "global" },
  });
  expectDraft(reconnected, "", outbox(queued, "global", "work").queue);
  expect(listOutboxes(reconnected)).toHaveLength(20);
});

it("restores an evicted live draft into a same-scope queue-only row", () => {
  const [state, persistence] = pane();
  edit(state, persistence, "merge this live draft");
  expectPersisted(persistence);

  const outboxes = fillOutboxes("queue-only");
  expect(snapshot(state)).toBeNull();

  releaseOutbox(outboxes[0]!);
  const sameScope = reconnectItem("same-scope-queue", 21);
  expect(admitItem(state, sameScope)).toBe(true);
  expectDraft(state, "", outbox(sameScope, state.sessionKey, "lily").queue);

  expectPersisted(persistence);
  expectDraft(state, "merge this live draft", outbox(sameScope, state.sessionKey, "lily").queue);
});

it.each([false, true])("fences an evicted pane (older attempt=%s)", (attempted) => {
  const baseline = savedState();
  const baselineRevision = revision(baseline);
  const [olderPane, olderPersistence] = pane(baseline.chatMessage);
  const earlyPane = attempted ? undefined : pane(baseline.chatMessage);
  const outboxes = fillOutboxes("failed-fence");
  expect(snapshot(baseline)).toBeNull();
  let olderResult: ReturnType<typeof failedWrite> | undefined;
  if (attempted) {
    edit(olderPane, olderPersistence, "older failed draft");
    olderResult = failedWrite(olderPersistence, baselineRevision);
  }
  // A late mount must use the committed CAS baseline, not the failed attempt.
  const [newerPane, newerPersistence] = earlyPane ?? pane(baseline.chatMessage);
  edit(newerPane, newerPersistence, "newer failed draft");
  const newerResult = failedWrite(newerPersistence, baselineRevision);
  if (olderResult) {
    expect(olderResult.draftRevision).toBeLessThan(newerResult.draftRevision);
  } else {
    expect(olderPersistence.persistForRouteSwitchResult()).toEqual({ status: "conflict" });
    expect(revision(olderPane)).toBe(newerResult.draftRevision);
  }
  releaseOutbox(outboxes[0]!);
  if (olderResult) {
    expect(retryDraft(olderPane, olderResult)).toBe(false);
  }
  expect(retryDraft(newerPane, newerResult)).toBe(true);
  expectDraft(newerPane, "newer failed draft");
  expect(revision(newerPane)).toBe(newerResult.draftRevision);
});

it("persists a revert after an intermediate draft attempt fails", () => {
  const state = savedState();
  const persistence = startPersistence(state);

  const outboxes = fillOutboxes("failed-revert");
  expect(snapshot(state)).toBeNull();

  edit(state, persistence, "intermediate edit");
  const failed = failedWrite(persistence);

  edit(state, persistence, "saved draft");
  persistence.schedule();
  releaseOutbox(outboxes[0]!);

  expectPersisted(persistence);
  expectDraft(state, "saved draft");
  expect(revision(state)).toBeGreaterThan(failed.draftRevision);
});

it("retries a failed draft write when stopping", () => {
  const write = vi.spyOn(sessionStorage, "setItem").mockImplementationOnce(quotaFailure);
  const [state, persistence] = pane();
  state.chatMessage = "retry this write";
  persistence.persistNow();
  persistence.stop();
  expect(write).toHaveBeenCalledTimes(2);
  expect(snapshot(state)?.draft).toBe("retry this write");
});

it("keeps failed attachment sends durable and retryable, including stack-overflow failures", () => {
  const state = createState();
  const failed: ChatQueueItem = {
    id: "overflow-attachment",
    text: "failed attachment send",
    createdAt: 1,
    sendState: "failed",
    sendError: "RangeError: Maximum call stack size exceeded",
    attachments: [
      {
        id: "att-overflow",
        mimeType: "image/png",
        fileName: "big.png",
        dataUrl: "data:image/png;base64,AAA",
      },
    ],
  };

  expect(
    admitStoredChatComposerQueueItemResult(
      state,
      captureChatOutboxAdmission(state, state.sessionKey),
      failed,
    ),
  ).toBe("admitted");
  expect(load(state, state.sessionKey).snapshot?.queue).toMatchObject([
    {
      id: "overflow-attachment",
      sendState: "failed",
      sendError: "RangeError: Maximum call stack size exceeded",
      attachments: [{ id: "att-overflow" }],
    },
  ]);
});

it.each(["canonical key", "arriving metadata"] as const)(
  "retires %s private storage, preserving live input and queues",
  (source) => {
    const state = createState({
      sessionKey:
        source === "canonical key" ? "agent:lily:dashboard:incognito-private" : "agent:lily:main",
      chatMessage: "@Alex private objective",
      chatMentions: privateMentions,
      chatGoalDraftMode: privateGoal,
      chatReplyTarget: { messageId: "private-reply", text: "Private quote" },
    });
    const queued = heldItem(state);
    if (source === "arriving metadata") {
      expect(persist(state)).toBe(true);
    }
    expect(admitItem(state, queued)).toBe(true);
    const storageKey = storageTargetForComposer(state).key;
    if (source === "canonical key") {
      const legacy = JSON.parse(sessionStorage.getItem(storageKey)!);
      Object.assign(legacy.sessions[`${state.sessionKey}\u0000agent:lily`], {
        draft: state.chatMessage,
        draftMentions: state.chatMentions,
        goalMode: state.chatGoalDraftMode,
        replyTarget: state.chatReplyTarget,
      });
      sessionStorage.setItem(storageKey, JSON.stringify(legacy));
    }
    const persistence = startPersistence(state);
    if (source === "arriving metadata") {
      state.selectedChatSessionIncognito = true;
      persistence.persistChangedState();
    }
    expect(persistence.durableScope).toBeNull();
    expect(sessionStorage.getItem(storageKey)).not.toContain("private objective");
    expect(persist(state)).toBe(true);
    const row = storedRow(state);
    expect(row).toMatchObject({ queue: [queued] });
    expect([row.draft, row.draftMentions, row.goalMode, row.replyTarget]).toEqual(
      Array(4).fill(undefined),
    );
    expect(new ChatComposerPersistence(() => state).restore()).toBe(true);
    expect(state).toMatchObject({
      chatMessage: "@Alex private objective",
      chatMentions: [expect.anything()],
      chatGoalDraftMode: { action: "start" },
    });
    reloadStorage(state);
    const restored = createState({ sessionKey: state.sessionKey });
    expect(new ChatComposerPersistence(() => restored).restore()).toBe(true);
    expect(restored).toMatchObject({ chatMessage: "", chatQueue: [queued] });
    persistence.stop();
  },
);

it("retires legacy private input during a queue update", () => {
  const state = createState({ sessionKey: "agent:lily:dashboard:incognito-queue" });
  const queued = heldItem(state, { sessionKey: state.sessionKey, agentId: "lily" });
  seedSession(
    {
      draft: "@Alex private legacy input",
      draftMentions: privateMentions,
      goalMode: privateGoal,
      draftRevision: 7,
      queue: [queued],
    },
    4,
    state.sessionKey,
  );
  expect(replaceItem(state, queued, { ...queued, text: "Edited submitted message" })).toBe(true);
  const row = storedRow(state);
  expect([row.draft, row.draftMentions, row.goalMode]).toEqual(Array(3).fill(undefined));
  expect(row).toMatchObject({ draftRevision: 7, queue: [{ text: "Edited submitted message" }] });
});

it("retires a draft when its write notification reveals Incognito metadata", async () => {
  const state = createState();
  const persistence = startPersistence(state);
  const reader = createStoredChatOutboxReader();
  const stopReader = reader.subscribe(() =>
    reader.read({ ...state, client: state.client ?? null, connected: state.connected ?? false }),
  );
  const unsubscribe = subscribeStoredChatOutboxChanges(() => {
    state.selectedChatSessionIncognito = true;
    persistence.persistChangedState();
  });
  try {
    state.chatMessage = "private notification draft";
    persistence.schedule();
    persistence.persistNow();
    expect(sessionStorage.getItem(storageTargetForComposer(state).key)).not.toContain(
      "private notification draft",
    );
    expect(state.chatMessage).toBe("private notification draft");
    expect(
      reader
        .read({ ...state, client: state.client ?? null, connected: state.connected ?? false })
        .hasSessionDraft(state.sessionKey),
    ).toBe(false);
  } finally {
    stopReader();
    unsubscribe();
    persistence.stop();
    await vi.dynamicImportSettled();
  }
});

it.each([true, false])("binds delayed drafts to captured privacy (%s)", (incognito) => {
  const state = createState({ selectedChatSessionIncognito: incognito });
  const sourceKey = state.sessionKey;
  const persistence = startPersistence(state);
  state.chatMessage = "captured draft";
  persistence.schedule();
  state.sessionKey = "agent:lily:destination";
  state.selectedChatSessionIncognito = !incognito;
  state.chatMessage = "destination input";
  persistence.persistNow();
  expect(snapshot(createState(), sourceKey)?.draft ?? "").toBe(incognito ? "" : "captured draft");
  expect(snapshot(state)).toBeNull();
  persistence.stop();
});

describe("chat composer draft presence notifications", () => {
  it("notifies stored outbox subscribers on draft presence transitions and queue writes", () => {
    const state = createState();
    const original = reconnectItem("notify", 1);
    const updated = { ...original, text: "updated message" };
    const listener = vi.fn();
    const unsubscribe = subscribeStoredChatOutboxChanges(listener);

    try {
      expect(persist({ ...state, chatMessage: "draft only" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      // Content-only re-persists stay silent so projection subscribers cannot
      // react by re-persisting a stale pane over the newer draft.
      expect(persist({ ...state, chatMessage: "draft only, edited" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(persist({ ...state, chatMessage: "" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(2);
      // Goal-only input badges the sidebar without text, so it is a presence transition too.
      const goalOnly = {
        ...state,
        chatMessage: "",
        chatGoalDraftMode: { action: "start" as const },
      };
      expect(persist(goalOnly)).toBe(true);
      expect(listener).toHaveBeenCalledTimes(3);
      expect(persist({ ...goalOnly, chatGoalDraftMode: null })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(4);
      expect(admitItem(state, original)).toBe(true);
      expect(listener).toHaveBeenCalledTimes(5);
      expect(
        updateItems(
          state,
          state.sessionKey,
          [{ expected: original, next: updated }],
          original.agentId,
        ),
      ).toBe(true);
      expect(listener).toHaveBeenCalledTimes(6);
    } finally {
      unsubscribe();
    }

    expect(
      updateItems(state, state.sessionKey, [{ expected: updated, next: null }], updated.agentId),
    ).toBe(true);
    expect(listener).toHaveBeenCalledTimes(6);
    const write = vi.spyOn(sessionStorage, "setItem");
    const remove = vi.spyOn(sessionStorage, "removeItem");
    const stop = subscribeStoredChatOutboxChanges(listener);
    try {
      expect(updateItems(state, state.sessionKey, [{ expected: updated, next: null }])).toBe(true);
      expect(write).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(listener).toHaveBeenCalledTimes(6);
    } finally {
      stop();
    }
  });
});
