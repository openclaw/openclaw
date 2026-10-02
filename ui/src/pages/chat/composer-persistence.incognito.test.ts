// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { outboxStorageScope } from "../../lib/chat/outbox-payload-store.runtime.ts";
import { createStoredChatOutboxReader } from "../../lib/chat/outbox-store-projection.ts";
import {
  captureChatOutboxAdmission,
  storageTargetForComposer,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  admitStoredChatComposerQueueItem,
  ChatComposerPersistence,
  loadChatComposerSnapshot,
  persistChatComposerState,
  removeStoredChatComposerQueueItem,
  restoreChatComposerState,
  updateStoredChatComposerQueueItem,
} from "./composer-persistence.ts";

type ComposerState = Parameters<typeof persistChatComposerState>[0] & {
  selectedChatSessionIncognito: boolean;
};

function createState(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    settings: { gatewayUrl: "ws://gateway.test/control" },
    connected: true,
    client: { recoveryScope: "credential", recoveryScopeReady: true },
    sessionKey: "agent:lily:main",
    chatMessage: "",
    chatQueue: [],
    selectedChatSessionIncognito: false,
    ...overrides,
  };
}

function reconnectItem(id: string, createdAt: number, state = createState()): ChatQueueItem {
  return {
    id,
    text: `message ${id}`,
    createdAt,
    storageScope: outboxStorageScope(state),
    sendRunId: `run-${id}`,
    sendState: "waiting-reconnect",
  };
}

function admitItem(state: ComposerState, item: ChatQueueItem, sessionKey = state.sessionKey) {
  return admitStoredChatComposerQueueItem(
    state,
    captureChatOutboxAdmission(state, sessionKey, item.agentId),
    item,
  );
}

function startPersistence(state: ComposerState) {
  const persistence = new ChatComposerPersistence(() => state);
  persistence.start();
  return persistence;
}

function reloadStorage(state: ComposerState) {
  const storageKey = storageTargetForComposer(state).key;
  const stored = sessionStorage.getItem(storageKey);
  expect(stored).not.toBeNull();
  const freshStorage = createStorageMock();
  freshStorage.setItem(storageKey, stored!);
  vi.stubGlobal("sessionStorage", freshStorage);
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Incognito composer persistence", () => {
  it("keeps canonical Incognito input out of storage before session metadata arrives", () => {
    const state = createState({
      sessionKey: "agent:lily:dashboard:incognito-private",
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
    expect(admitItem(state, queued)).toBe(true);
    const storageKey = storageTargetForComposer(state).key;
    const legacy = JSON.parse(sessionStorage.getItem(storageKey)!);
    Object.assign(legacy.sessions[`${state.sessionKey}\u0000agent:lily`], {
      draft: state.chatMessage,
      draftMentions: state.chatMentions,
      goalMode: state.chatGoalDraftMode,
      replyTarget: state.chatReplyTarget,
    });
    sessionStorage.setItem(storageKey, JSON.stringify(legacy));
    const persistence = startPersistence(state);
    expect(persistence.durableScope).toBeNull();
    expect(sessionStorage.getItem(storageKey)).not.toContain("private objective");
    expect(persistChatComposerState(state)).toBe(true);
    const stored = JSON.parse(sessionStorage.getItem(storageTargetForComposer(state).key)!);
    expect(stored.sessions[`${state.sessionKey}\u0000agent:lily`]).toMatchObject({
      queue: [queued],
    });
    expect(stored.sessions[`${state.sessionKey}\u0000agent:lily`].draft).toBeUndefined();
    expect(stored.sessions[`${state.sessionKey}\u0000agent:lily`].draftMentions).toBeUndefined();
    expect(stored.sessions[`${state.sessionKey}\u0000agent:lily`].goalMode).toBeUndefined();
    expect(stored.sessions[`${state.sessionKey}\u0000agent:lily`].replyTarget).toBeUndefined();
    expect(restoreChatComposerState(state)).toBe(true);
    expect(state.chatMessage).toBe("@Alex private objective");
    expect(state.chatMentions).toHaveLength(1);
    expect(state.chatGoalDraftMode?.action).toBe("start");
    reloadStorage(state);
    const restored = createState({ sessionKey: state.sessionKey });
    expect(restoreChatComposerState(restored)).toBe(true);
    expect(restored.chatMessage).toBe("");
    expect(restored.chatQueue).toMatchObject([queued]);
    persistence.stop();
  });

  it.each(["admit", "update", "remove"] as const)(
    "retires legacy private input during queue %s",
    (operation) => {
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
      if (operation === "admit") {
        expect(admitItem(state, { ...queued, id: "second" })).toBe(true);
      } else if (operation === "update") {
        expect(
          updateStoredChatComposerQueueItem(state, state.sessionKey, queued, {
            ...queued,
            text: "Edited submitted message",
          }),
        ).toBe(true);
      } else {
        expect(removeStoredChatComposerQueueItem(state, state.sessionKey, queued.id, queued)).toBe(
          true,
        );
      }
      const stored = JSON.parse(sessionStorage.getItem(storageKey)!);
      const row = stored.sessions[`${state.sessionKey}\u0000agent:lily`];
      expect(row.draft).toBeUndefined();
      expect(row.draftMentions).toBeUndefined();
      expect(row.goalMode).toBeUndefined();
      expect(row.draftRevision).toBe(7);
      expect(row.queue?.map((item: ChatQueueItem) => item.text) ?? []).toEqual(
        operation === "admit"
          ? [queued.text, queued.text]
          : operation === "update"
            ? ["Edited submitted message"]
            : [],
      );
    },
  );

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

  it("retires legacy unsent fields when Incognito metadata arrives without clearing live input or queues", () => {
    const state = createState({
      chatMessage: "@Alex private legacy draft",
      chatMentions: [{ profileId: "alex", start: 0, end: 5 }],
      chatGoalDraftMode: { action: "start", sessionId: "private-session" },
      chatReplyTarget: { messageId: "private-reply", text: "Private quote" },
    });
    expect(persistChatComposerState(state)).toBe(true);
    const queued = { ...reconnectItem("legacy-queue", 1), sendState: "held" as const };
    expect(admitItem(state, queued)).toBe(true);
    const persistence = startPersistence(state);
    state.selectedChatSessionIncognito = true;
    persistence.persistChangedState();
    expect(state.chatMessage).toBe("@Alex private legacy draft");
    expect(state.chatMentions).toHaveLength(1);
    expect(state.chatGoalDraftMode?.action).toBe("start");
    const stored = JSON.parse(sessionStorage.getItem(storageTargetForComposer(state).key)!);
    const row = stored.sessions[`${state.sessionKey}\u0000agent:lily`];
    expect(row.draft).toBeUndefined();
    expect(row.draftMentions).toBeUndefined();
    expect(row.goalMode).toBeUndefined();
    expect(row.queue).toMatchObject([queued]);
    persistence.stop();
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
      expect(loadChatComposerSnapshot(createState(), sourceKey)?.draft ?? "").toBe(
        incognito ? "" : "captured draft",
      );
      expect(loadChatComposerSnapshot(state, state.sessionKey)).toBeNull();
      persistence.stop();
    },
  );
});
