// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { outboxStorageScope } from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "../../lib/chat/outbox-recovery.ts";
import { createStoredChatOutboxReader } from "../../lib/chat/outbox-store-projection.ts";
import {
  captureChatOutboxAdmission,
  storageTargetForComposer,
  storageTargetForGateway,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  legacyStorageKeyForGateway,
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
import {
  type ChatComposerPersistence,
  admitStoredChatComposerQueueItem,
  listStoredChatOutboxes,
  loadChatComposerState,
  persistChatComposerState as persist,
  removeStoredChatComposerQueueItem as removeItem,
  restoreChatComposerState as restore,
  updateStoredChatComposerQueueItems as updateItems,
} from "./composer-persistence.ts";

type ComposerState = Parameters<typeof persist>[0] & {
  selectedChatSessionIncognito: boolean;
};

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
  sessionStorage.setItem(
    key,
    JSON.stringify({
      version,
      ...(version === 1 ? {} : { gatewayOwner: gatewayUrl, recovery: {} }),
      sessions,
    }),
  );
}

function seedSession(session: Record<string, unknown>, version: number) {
  seedSessions({ "agent:lily:main\u0000agent:lily": session }, version);
}

function expectDraft(state: ComposerState, draft: string, queue: ChatQueueItem[] = []) {
  expect(loadChatComposerState(state, state.sessionKey).snapshot).toEqual({ draft, queue });
}

function outbox(item: ChatQueueItem, sessionKey: string, agentId?: string) {
  const scope = { sessionKey, ...(agentId ? { agentId } : {}) };
  return { ...scope, queue: [{ ...item, ...scope }] };
}

function fillDrafts(prefix: string, count: number, chatMessage: string) {
  for (let index = 0; index < count; index += 1) {
    expect(
      persist(createState({ sessionKey: `agent:${prefix}-${index}:thread`, chatMessage })),
    ).toBe(true);
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

it("restores selected recipients and gives same-text recipient changes their own revision", () => {
  const first = [{ profileId: "alex-one", start: 0, end: 5 }];
  const second = [{ profileId: "alex-two", start: 0, end: 5 }];
  const state = createState({ chatMessage: "@Alex", chatMentions: first });
  expect(persist(state, state.sessionKey, { draftRevision: 10 })).toBe(true);
  const queued = reconnectItem("keep-draft-mentions", 1);
  expect(admitItem(state, queued)).toBe(true);
  expect(removeItem(state, state.sessionKey, queued.id)).toBe(true);
  const restored = createState();
  expect(restore(restored)).toBe(true);
  expect(restored.chatMentions).toEqual(first);
  expect(persist(state, state.sessionKey, { draftRevision: 10, mentions: second })).toBe(false);

  const persistence = startPersistence(state);
  state.chatMentions = second;
  persistence.schedule();
  persistence.persistChangedState();
  expect(loadChatComposerState(state, state.sessionKey).snapshot?.mentions).toEqual(second);
  expect(loadChatComposerState(state, state.sessionKey).revisions.latestAttempt).toBeGreaterThan(
    10,
  );
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
  const state = createState({
    chatMessage: "  /goal clear\n  literal objective ",
    chatGoalDraftMode: goalMode,
    agentsList: { defaultId: "lily", mainKey: "main" },
  });
  expect(persist(state)).toBe(true);
  const restored = createState();
  expect(restore(restored)).toBe(true);
  expect(restored.chatMessage).toBe(state.chatMessage);
  expect(restored.chatGoalDraftMode).toEqual(goalMode);
  expect(loadChatComposerState(state, "agent:lily:other").snapshot).toBeNull();
  const queued = reconnectItem("other-message", 1);
  expect(admitItem(state, queued)).toBe(true);
  expect(removeItem(state, state.sessionKey, queued.id)).toBe(true);
  expect(loadChatComposerState(state, state.sessionKey).snapshot?.goalMode).toEqual(goalMode);
});

it("normalizes an existing whitespace-only stored draft during restore", () => {
  const state = createState();
  seedSession({ draft: "  \n  ", draftRevision: 1, updatedAt: 1 }, 4);

  expect(restore(state)).toBe(false);
  expect(state.chatMessage).toBe("");
});

it("reviews legacy steer rows as generic mode-bearing sends and never rewrites old fields", () => {
  const state = createState({ agentsList: { defaultId: "lily", mainKey: "main" } });
  const storageKey = storageTargetForComposer(state).key;
  seedSession(
    {
      queue: [
        {
          ...legacyReconnectItem("steer-reload", 1),
          kind: "steered",
          sendRunId: "steer-request",
          sendState: "steering",
          steerTargetRunId: "active-run",
        },
      ],
      updatedAt: 1,
    },
    2,
  );

  const restored = reviewLegacyItem(state, "steer-reload");
  expect(restored).toMatchObject({
    id: "steer-reload",
    storageScope: outboxStorageScope(state),
    queueMode: "steer",
    sendRunId: "steer-request",
    sendState: "unconfirmed",
  });
  expect(restored).not.toHaveProperty("kind");
  expect(restored).not.toHaveProperty("steerTargetRunId");

  expect(
    updateItems(
      state,
      state.sessionKey,
      [{ expected: restored!, next: { ...restored!, text: "updated" } }],
      restored?.agentId,
    ),
  ).toBe(true);
  const written = sessionStorage.getItem(storageKey) ?? "";
  expect(written).toContain('"queueMode":"steer"');
  expect(written).not.toContain('"kind":"steered"');
  expect(written).not.toContain("steerTargetRunId");
  expect(written).not.toContain('"sendState":"steering"');
});

it("does not erase another split pane draft when its own draft is unchanged", () => {
  const untouchedPane = createState();
  const untouchedPersistence = startPersistence(untouchedPane);

  const editedPane = createState({ chatMessage: "draft from the other pane" });
  expect(persist(editedPane)).toBe(true);

  expect(untouchedPersistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
  expect(loadChatComposerState(editedPane, editedPane.sessionKey).snapshot?.draft).toBe(
    "draft from the other pane",
  );
});

it("keeps the later edit when split pane timers flush in natural order", () => {
  vi.useFakeTimers();
  const firstPane = createState();
  const firstPersistence = startPersistence(firstPane);
  const secondPane = createState();
  const secondPersistence = startPersistence(secondPane);

  firstPane.chatMessage = "first draft";
  firstPersistence.schedule();
  vi.advanceTimersByTime(10);
  secondPane.chatMessage = "later draft";
  secondPersistence.schedule();

  vi.advanceTimersByTime(190);
  expect(loadChatComposerState(firstPane, firstPane.sessionKey).snapshot?.draft).toBe(
    "first draft",
  );

  vi.advanceTimersByTime(10);
  expect(loadChatComposerState(secondPane, secondPane.sessionKey).snapshot?.draft).toBe(
    "later draft",
  );
});

it("fences an older pane after a newer clear and allows a subsequent edit", () => {
  vi.useFakeTimers();
  const initial = createState({ chatMessage: "saved draft" });
  expect(persist(initial)).toBe(true);
  const olderPane = createState({ chatMessage: "saved draft" });
  const olderPersistence = startPersistence(olderPane);
  const clearingPane = createState({ chatMessage: "saved draft" });
  const clearingPersistence = startPersistence(clearingPane);

  olderPane.chatMessage = "stale replacement";
  olderPersistence.schedule();
  clearingPane.chatMessage = "";
  clearingPersistence.schedule();
  expect(clearingPersistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });

  vi.advanceTimersByTime(200);

  expect(loadChatComposerState(initial, initial.sessionKey).snapshot).toBeNull();
  expect(olderPersistence.persistForRouteSwitchResult().status).toBe("conflict");
  olderPane.chatMessage = "newest draft after conflict";
  olderPersistence.schedule();
  vi.advanceTimersByTime(200);
  expect(loadChatComposerState(olderPane, olderPane.sessionKey).snapshot?.draft).toBe(
    "newest draft after conflict",
  );
});

it("persists a delayed global draft to the agent scope captured when typed", () => {
  const state = createState({
    assistantAgentId: "alpha",
    chatMessage: "",
    sessionKey: "global",
  });
  const persistence = startPersistence(state);
  state.chatMessage = "alpha draft";
  persistence.schedule();

  const beta = createState({
    assistantAgentId: "beta",
    chatMessage: "beta draft",
    sessionKey: "global",
  });
  expect(persist(beta)).toBe(true);
  state.assistantAgentId = "beta";

  expect(persistence.scopeForRouteSwitch()).toEqual({
    sessionKey: "global",
    agentId: "alpha",
  });
  expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
  expect(persistence.scopeForRouteSwitch()).toEqual({
    sessionKey: "global",
    agentId: "alpha",
  });
  expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
  expect(
    loadChatComposerState({ ...state, assistantAgentId: "alpha" }, "global").snapshot?.draft,
  ).toBe("alpha draft");
  expect(loadChatComposerState(beta, "global").snapshot?.draft).toBe("beta draft");
});

it("rejects conflicting admission of an existing item id", () => {
  const item = reconnectItem("same-id", 1);
  expect(admitItem(createState(), item)).toBe(true);
  expect(admitItem(createState(), { ...item, text: "different payload" })).toBe(false);
});

it("rejects stale updates and deletes after an attachment payload replacement", () => {
  const state = createState({
    chatMessage: "keep this draft",
    client: { recoveryScope: "versioned-owner", recoveryScopeReady: true },
  });
  expect(persist(state)).toBe(true);
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
  expect(updateItems(state, state.sessionKey, [{ expected: original, next: successor }])).toBe(
    true,
  );
  expect(
    updateItems(state, state.sessionKey, [
      { expected: original, next: { ...original, sendAttempts: 2 } },
    ]),
  ).toBe(false);
  expect(removeItem(state, state.sessionKey, original.id, original)).toBe(false);
  expect(loadChatComposerState(state, state.sessionKey).snapshot?.queue[0]).toMatchObject(
    successor,
  );
  expect(removeItem(state, state.sessionKey, successor.id, successor)).toBe(true);
  expectDraft(state, "keep this draft");
});

it("keeps unresolved bare main and raw global independent until their owners resolve", () => {
  const offlineMain = createState({ sessionKey: "main" });
  const offlineGlobal = createState({ sessionKey: "global" });
  const mainItem = reconnectItem("unresolved-main", 1);
  const globalItem = reconnectItem("unresolved-global", 2);
  expect(admitItem(offlineMain, mainItem)).toBe(true);
  expect(admitItem(offlineGlobal, globalItem)).toBe(true);
  expect(listStoredChatOutboxes(offlineMain)).toEqual([
    outbox(mainItem, "main"),
    outbox(globalItem, "global"),
  ]);
  const resolved = createState({
    agentsList: { defaultId: "work", mainKey: "main", scope: "global" },
    assistantAgentId: "alpha",
    sessionKey: "global",
  });
  const mainBox = outbox(mainItem, "global", "work");
  const globalBox = outbox(globalItem, "global", "alpha");
  expect(listStoredChatOutboxes(resolved)).toEqual([mainBox, globalBox]);
  const attemptedMain = { ...mainBox.queue[0]!, sendAttempts: 1 };
  const attemptedGlobal = { ...globalBox.queue[0]!, sendAttempts: 1 };
  expect(
    updateItems(resolved, "global", [{ expected: mainBox.queue[0]!, next: attemptedMain }]),
  ).toBe(true);
  expect(
    updateItems(resolved, "global", [{ expected: globalBox.queue[0]!, next: attemptedGlobal }]),
  ).toBe(true);
  expect(removeItem(resolved, "global", mainItem.id, attemptedMain)).toBe(true);
  expect(listStoredChatOutboxes(resolved)).toEqual([outbox(attemptedGlobal, "global", "alpha")]);
  expect(removeItem(resolved, "global", globalItem.id, attemptedGlobal)).toBe(true);
  expect(listStoredChatOutboxes(resolved)).toEqual([]);
});

it("retains ambiguous shipped main rows for explicit destination confirmation", () => {
  const item = legacyReconnectItem("legacy-main", 1);
  seedSessions({ "main\u0000agent:previous": { queue: [item], updatedAt: 1 } });
  const state = createState({ agentsList: { defaultId: "work", mainKey: "main" } });
  expect(listStoredChatOutboxes(state)).toEqual([]);
  expect(readChatOutboxRecovery(state).entries[0]?.session.queue).toEqual([item]);
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
  const expected = {
    ...first,
    storageScope: outboxStorageScope(state),
    sendState: "failed" as const,
    sendError: "Recovered message. Review this destination and retry only if it did not arrive.",
  };
  expect(listStoredChatOutboxes(state)).toEqual([outbox(expected, sessionKey)]);
  expectDraft(state, "older draft", outbox(expected, sessionKey).queue);

  const attempted = { ...restored, sendAttempts: 1 };
  expect(updateItems(state, sessionKey, [{ expected: restored, next: attempted }])).toBe(true);
  expect(removeItem(state, sessionKey, first.id, attempted)).toBe(true);
  expectDraft(state, "older draft");
  expect(readChatOutboxRecovery(state).entries).toHaveLength(1);
  expect(readChatOutboxRecovery(state).entries[0]?.session).toMatchObject({
    draft: "newer draft",
    queue: [second],
  });
  const stored = JSON.parse(sessionStorage.getItem(storageTargetForComposer(state).key)!);
  expect(Object.keys(stored.sessions)).toEqual([sessionKey + "\u0000agent:main"]);
});

it("keeps readable migrated composer state when the migration write fails", () => {
  const unresolved = createState({
    chatMessage: "unresolved draft",
    sessionKey: "main",
  });
  const item = reconnectItem("unresolved-with-quota", 1);
  expect(persist(unresolved)).toBe(true);
  expect(admitItem(unresolved, item, "main")).toBe(true);
  vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
    throw new DOMException("quota exceeded", "QuotaExceededError");
  });

  const resolved = createState({
    agentsList: { defaultId: "work", mainKey: "main", scope: "global" },
    assistantAgentId: "work",
    sessionKey: "global",
  });
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
    expect(loadChatComposerState(state, sessionKey).snapshot).toBeNull();
  }
  expect(listStoredChatOutboxes(state)).toEqual([]);
  const entries = readChatOutboxRecovery(state).entries;
  expect(entries).toHaveLength(3);
  expect(sessionStorage.getItem(storageTargetForComposer(state).key)).toBeNull();
  for (const [sessionKey, queue] of [
    ["global", globalQueue],
    [mainKey, mainQueue],
  ] as const) {
    const expectedQueue = structuredClone(queue);
    for (const item of expectedQueue) {
      item.sessionKey = sessionKey;
      item.agentId = "work";
    }
    expect(
      entries.find((entry) => entry.sourceScopeKey === sessionKey + "\u0000agent:work")?.session
        .queue,
    ).toEqual(expectedQueue);
  }
  for (const sessionKey of ["global", mainKey, "agent:work:notes"]) {
    const entry = entries.find(
      (candidate) => candidate.sourceScopeKey === sessionKey + "\u0000agent:work",
    );
    expect(entry).toBeDefined();
    const destination = captureChatOutboxRecoveryDestination(
      state,
      resolveUiConversationIdentity(state, sessionKey, "work"),
    );
    expect(destination).not.toBeNull();
    expect(restoreChatOutboxRecovery(state, entry!, destination!)).toBe("restored");
  }
  const reviewedItem = (item: ChatQueueItem) => ({
    ...item,
    storageScope: outboxStorageScope(state),
    sendState: "failed" as const,
    sendError:
      item.id === "main-0"
        ? "RangeError: Maximum call stack size exceeded"
        : "Recovered message. Review this destination and retry only if it did not arrive.",
  });
  expect(loadChatComposerState(state, "agent:work:notes").snapshot?.draft).toBe("draft only");
  expectDraft(
    state,
    "legacy draft",
    mainQueue.map((item) => ({ ...reviewedItem(item), sessionKey: mainKey, agentId: "work" })),
  );
  expect(loadChatComposerState(state, "global").snapshot?.queue).toEqual(
    globalQueue.map((item) => ({ ...reviewedItem(item), sessionKey: "global", agentId: "work" })),
  );
  expect(
    listStoredChatOutboxes(state)
      .flatMap((box) => box.queue)
      .map((item) => item.id),
  ).toEqual([...globalQueue, ...mainQueue].map((item) => item.id));
  expect(readChatOutboxRecovery(state).entries).toEqual([]);
  state.chatMessage = "updated draft";
  expect(persist(state)).toBe(true);
  expect(sessionStorage.getItem(storageTargetForComposer(state).key)).not.toContain(
    "removedQueueItemIds",
  );
  expect(sessionStorage.getItem(legacyStorageKeyForGateway(state.settings?.gatewayUrl))).toBeNull();
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
    expect(loadChatComposerState(state, state.sessionKey).snapshot?.queue).toEqual(
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
  expect(legacyStorageKeyForGateway(gateways[0]!.state.settings?.gatewayUrl)).toBe(
    legacyStorageKeyForGateway(gateways[1]!.state.settings?.gatewayUrl),
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
    const stored = JSON.parse(sessionStorage.getItem(storageTargetForComposer(state).key) ?? "{}");
    expect(stored).toMatchObject({ gatewayOwner: state.settings?.gatewayUrl, version: 4 });
  }
});

it("does not replay an exact-240 legacy key to a longer same-prefix gateway", () => {
  const prefix = "wss://gateway.test/";
  const exactGatewayUrl = `${prefix}${"a".repeat(240 - encodeURIComponent(prefix).length)}`;
  const longerGatewayUrl = `${exactGatewayUrl}b`;
  expect(encodeURIComponent(exactGatewayUrl)).toHaveLength(240);
  expect(legacyStorageKeyForGateway(exactGatewayUrl)).toBe(
    legacyStorageKeyForGateway(longerGatewayUrl),
  );
  const item = legacyReconnectItem("ambiguous-legacy-owner", 1);
  seedSessions(
    { "agent:lily:main\u0000agent:lily": { queue: [item], updatedAt: 1 } },
    1,
    exactGatewayUrl,
  );

  for (const gatewayUrl of [exactGatewayUrl, longerGatewayUrl]) {
    const state = createState({ settings: { gatewayUrl } });
    expect(loadChatComposerState(state, state.sessionKey).snapshot).toBeNull();
    expect(listStoredChatOutboxes(state)).toEqual([]);
    expect(sessionStorage.getItem(storageTargetForComposer(state).key)).toBeNull();
    expect(readChatOutboxRecovery(state).entries).toEqual([]);
    expect(sessionStorage.getItem(legacyStorageKeyForGateway(gatewayUrl))).toContain(item.id);
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
  expect(loadChatComposerState(createState(), draftSessionKey).snapshot).toBeNull();
  expect(listStoredChatOutboxes(createState())).toHaveLength(20);

  const rejectedDraft = createState({ sessionKey: "agent:lily:rejected-draft" });
  const rejectedPersistence = startPersistence(rejectedDraft);
  rejectedDraft.chatMessage = "keep retrying this draft";
  rejectedPersistence.schedule();
  failedWrite(rejectedPersistence, 0);
  expect(loadChatComposerState(rejectedDraft, rejectedDraft.sessionKey).snapshot).toBeNull();

  const overflowSessionKey = "agent:lily:queued:20";
  expect(
    admitItem(createState({ sessionKey: overflowSessionKey }), reconnectItem("queued-20", 20)),
  ).toBe(false);
  const outboxes = listStoredChatOutboxes(createState());
  expect(outboxes).toHaveLength(20);
  expect(outboxes.some((box) => box.sessionKey === overflowSessionKey)).toBe(false);
  expect(outboxes.some((box) => box.sessionKey === "agent:lily:queued:0")).toBe(true);
});

it("retains an unresolved custom-main clear through draft and outbox capacity pressure", () => {
  const resolved = createState({
    assistantAgentId: "work",
    chatMessage: "stale resolved draft",
    sessionKey: "global",
  });
  const queued = reconnectItem("resolved-work-queue", 1);
  expect(persist(resolved)).toBe(true);
  expect(admitItem(resolved, queued)).toBe(true);

  const offline = createState({ sessionKey: "workspace", chatMessage: "stale resolved draft" });
  expect(persist(offline)).toBe(true);
  expect(restore(offline)).toBe(true);
  expect(offline.chatMessage).toBe("stale resolved draft");
  const persistence = startPersistence(offline);
  offline.chatMessage = "";
  persistence.schedule();
  expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });

  fillDrafts("newer-draft", 21, "newer ordinary draft");

  fillOutboxes("clear-capacity", 19);
  expect(listStoredChatOutboxes(offline)).toHaveLength(20);

  fillDrafts("newer-clear", 25, "");
  reloadStorage(offline);

  expect(
    loadChatComposerState(createState({ sessionKey: "workspace" }), "workspace").snapshot,
  ).toBeNull();
  const reconnected = createState({
    agentsList: { defaultId: "work", mainKey: "workspace", scope: "global" },
    assistantAgentId: "work",
    sessionKey: "global",
  });
  expectDraft(reconnected, "", outbox(queued, "global", "work").queue);
  expect(listStoredChatOutboxes(reconnected)).toHaveLength(20);
});

it("restores an evicted live draft into a same-scope queue-only row", () => {
  const state = createState();
  const persistence = startPersistence(state);
  state.chatMessage = "merge this live draft";
  persistence.schedule();
  expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });

  const outboxes = fillOutboxes("queue-only");
  expect(loadChatComposerState(state, state.sessionKey).snapshot).toBeNull();

  releaseOutbox(outboxes[0]!);
  const sameScope = reconnectItem("same-scope-queue", 21);
  expect(admitItem(state, sameScope)).toBe(true);
  expectDraft(state, "", outbox(sameScope, state.sessionKey, "lily").queue);

  expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
  expectDraft(state, "merge this live draft", outbox(sameScope, state.sessionKey, "lily").queue);
});

it("lets only the newest failed split-pane draft retry after capacity recovers", () => {
  const baseline = createState({ chatMessage: "saved draft" });
  expect(persist(baseline)).toBe(true);
  const baselineRevision = loadChatComposerState(baseline, baseline.sessionKey).revisions
    .latestAttempt;
  const olderPane = createState({ chatMessage: baseline.chatMessage });
  const olderPersistence = startPersistence(olderPane);

  const outboxes = fillOutboxes("failed-fence");
  expect(loadChatComposerState(baseline, baseline.sessionKey).snapshot).toBeNull();

  olderPane.chatMessage = "older failed draft";
  olderPersistence.schedule();
  const olderResult = failedWrite(olderPersistence, baselineRevision);

  // A pane mounted after the failed attempt must issue after it without
  // treating that uncommitted attempt as the persisted CAS baseline.
  const newerPane = createState({ chatMessage: baseline.chatMessage });
  const newerPersistence = startPersistence(newerPane);
  newerPane.chatMessage = "newer late-pane draft";
  newerPersistence.schedule();
  const newerResult = failedWrite(newerPersistence, baselineRevision);
  expect(olderResult.draftRevision).toBeLessThan(newerResult.draftRevision);

  releaseOutbox(outboxes[0]!);
  expect(retryDraft(olderPane, olderResult)).toBe(false);
  expect(retryDraft(newerPane, newerResult)).toBe(true);
  expectDraft(newerPane, "newer late-pane draft");
  expect(loadChatComposerState(newerPane, newerPane.sessionKey).revisions.latestAttempt).toBe(
    newerResult.draftRevision,
  );
});

it("does not let an untouched evicted pane fence out a newer failed edit", () => {
  const baseline = createState({ chatMessage: "saved draft" });
  expect(persist(baseline)).toBe(true);
  const baselineRevision = loadChatComposerState(baseline, baseline.sessionKey).revisions
    .latestAttempt;
  const stalePane = createState({ chatMessage: baseline.chatMessage });
  const stalePersistence = startPersistence(stalePane);
  const newerPane = createState({ chatMessage: baseline.chatMessage });
  const newerPersistence = startPersistence(newerPane);

  const outboxes = fillOutboxes("stale-fence");
  expect(loadChatComposerState(baseline, baseline.sessionKey).snapshot).toBeNull();

  newerPane.chatMessage = "newer failed draft";
  newerPersistence.schedule();
  const newerResult = failedWrite(newerPersistence, baselineRevision);

  expect(stalePersistence.persistForRouteSwitchResult()).toEqual({ status: "conflict" });
  expect(loadChatComposerState(stalePane, stalePane.sessionKey).revisions.latestAttempt).toBe(
    newerResult.draftRevision,
  );

  releaseOutbox(outboxes[0]!);
  expect(retryDraft(newerPane, newerResult)).toBe(true);
  expectDraft(newerPane, "newer failed draft");
});

it("persists a revert after an intermediate draft attempt fails", () => {
  const state = createState({ chatMessage: "saved draft" });
  expect(persist(state)).toBe(true);
  const persistence = startPersistence(state);

  const outboxes = fillOutboxes("failed-revert");
  expect(loadChatComposerState(state, state.sessionKey).snapshot).toBeNull();

  state.chatMessage = "intermediate edit";
  persistence.schedule();
  const failed = failedWrite(persistence);

  state.chatMessage = "saved draft";
  persistence.schedule();
  persistence.schedule();
  releaseOutbox(outboxes[0]!);

  expect(persistence.persistForRouteSwitchResult()).toEqual({ status: "persisted" });
  expectDraft(state, "saved draft");
  expect(loadChatComposerState(state, state.sessionKey).revisions.latestAttempt).toBeGreaterThan(
    failed.draftRevision,
  );
});

it("retries a failed draft write when stopping", () => {
  const write = vi.spyOn(sessionStorage, "setItem").mockImplementationOnce(() => {
    throw new DOMException("quota exceeded", "QuotaExceededError");
  });
  const state = createState();
  const persistence = startPersistence(state);
  state.chatMessage = "retry this write";
  persistence.persistNow();
  persistence.stop();
  expect(write).toHaveBeenCalledTimes(2);
  expect(loadChatComposerState(state, state.sessionKey).snapshot?.draft).toBe("retry this write");
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
    admitStoredChatComposerQueueItem(
      state,
      captureChatOutboxAdmission(state, state.sessionKey),
      failed,
    ),
  ).toBe(true);
  expect(loadChatComposerState(state, state.sessionKey).snapshot?.queue).toMatchObject([
    {
      id: "overflow-attachment",
      sendState: "failed",
      sendError: "RangeError: Maximum call stack size exceeded",
      attachments: [{ id: "att-overflow" }],
    },
  ]);
});

describe("Incognito composer persistence", () => {
  it.each(["canonical key", "arriving metadata"] as const)(
    "retires Incognito input identified by %s without clearing live input or queues",
    (source) => {
      const state = createState({
        sessionKey:
          source === "canonical key" ? "agent:lily:dashboard:incognito-private" : "agent:lily:main",
        chatMessage: "@Alex private objective",
        chatMentions: [{ profileId: "alex", start: 0, end: 5 }],
        chatGoalDraftMode: { action: "start", sessionId: "private-session" },
        chatReplyTarget: { messageId: "private-reply", text: "Private quote" },
        connected: true,
        client: { recoveryScope: "credential", recoveryScopeReady: true },
      });
      const queued: ChatQueueItem = {
        id: "submitted",
        storageScope: outboxStorageScope(state),
        text: "Submitted private message",
        createdAt: 1,
        sendState: "held",
      };
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
      const stored = JSON.parse(sessionStorage.getItem(storageTargetForComposer(state).key)!);
      expect(stored.sessions[`${state.sessionKey}\u0000agent:lily`]).toMatchObject({
        queue: [queued],
      });
      expect(stored.sessions[`${state.sessionKey}\u0000agent:lily`].draft).toBeUndefined();
      expect(stored.sessions[`${state.sessionKey}\u0000agent:lily`].draftMentions).toBeUndefined();
      expect(stored.sessions[`${state.sessionKey}\u0000agent:lily`].goalMode).toBeUndefined();
      expect(stored.sessions[`${state.sessionKey}\u0000agent:lily`].replyTarget).toBeUndefined();
      expect(restore(state)).toBe(true);
      expect(state.chatMessage).toBe("@Alex private objective");
      expect(state.chatMentions).toHaveLength(1);
      expect(state.chatGoalDraftMode?.action).toBe("start");
      reloadStorage(state);
      const restored = createState({ sessionKey: state.sessionKey });
      expect(restore(restored)).toBe(true);
      expect(restored.chatMessage).toBe("");
      expect(restored.chatQueue).toMatchObject([queued]);
      persistence.stop();
    },
  );

  it("retires legacy private input during a queue update", () => {
    const state = createState({ sessionKey: "agent:lily:dashboard:incognito-queue" });
    const queued: ChatQueueItem = {
      id: "submitted",
      storageScope: outboxStorageScope(state),
      sessionKey: state.sessionKey,
      agentId: "lily",
      text: "Submitted private message",
      createdAt: 1,
      sendState: "held",
    };
    const storageKey = storageTargetForComposer(state).key;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 4,
        gatewayOwner: storageTargetForComposer(state).gatewayOwner,
        recovery: {},
        sessions: {
          [`${state.sessionKey}\u0000agent:lily`]: {
            draft: "@Alex private legacy input",
            draftMentions: [{ profileId: "alex", start: 0, end: 5 }],
            goalMode: { action: "start", sessionId: "private-session" },
            draftRevision: 7,
            queue: [queued],
            updatedAt: 1,
          },
        },
      }),
    );
    expect(
      updateItems(state, state.sessionKey, [
        {
          expected: queued,
          next: {
            ...queued,
            text: "Edited submitted message",
          },
        },
      ]),
    ).toBe(true);
    const stored = JSON.parse(sessionStorage.getItem(storageKey)!);
    const row = stored.sessions[`${state.sessionKey}\u0000agent:lily`];
    expect(row.draft).toBeUndefined();
    expect(row.draftMentions).toBeUndefined();
    expect(row.goalMode).toBeUndefined();
    expect(row.draftRevision).toBe(7);
    expect(row.queue?.map((item: ChatQueueItem) => item.text) ?? []).toEqual([
      "Edited submitted message",
    ]);
  });

  it("retires a draft when its write notification reveals Incognito metadata", () => {
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
    }
  });

  it.each([true, false])(
    "keeps delayed drafts bound to their captured Incognito status (%s)",
    (incognito) => {
      const state = createState({ selectedChatSessionIncognito: incognito });
      const sourceKey = state.sessionKey;
      const persistence = startPersistence(state);
      state.chatMessage = "captured draft";
      persistence.schedule();
      state.sessionKey = "agent:lily:destination";
      state.selectedChatSessionIncognito = !incognito;
      state.chatMessage = "destination input";
      persistence.persistNow();
      expect(loadChatComposerState(createState(), sourceKey).snapshot?.draft ?? "").toBe(
        incognito ? "" : "captured draft",
      );
      expect(loadChatComposerState(state, state.sessionKey).snapshot).toBeNull();
      persistence.stop();
    },
  );
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

    expect(removeItem(state, state.sessionKey, updated.id, updated, updated.agentId)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(6);
  });
});
