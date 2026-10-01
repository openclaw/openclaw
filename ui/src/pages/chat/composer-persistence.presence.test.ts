// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  captureChatOutboxAdmission,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  admitStoredChatComposerQueueItem,
  persistChatComposerState,
  removeStoredChatComposerQueueItem,
  updateStoredChatComposerQueueItem,
} from "./composer-persistence.ts";

type ComposerState = Parameters<typeof persistChatComposerState>[0];

function createState(): ComposerState {
  return {
    settings: { gatewayUrl: "ws://gateway.test/control" },
    sessionKey: "agent:lily:main",
    chatMessage: "",
    chatQueue: [],
  };
}

function reconnectItem(id: string, createdAt: number): ChatQueueItem {
  return {
    id,
    text: `message ${id}`,
    createdAt,
    sendRunId: `run-${id}`,
    sendState: "waiting-reconnect",
  };
}

function admitItem(state: ComposerState, item: ChatQueueItem) {
  return admitStoredChatComposerQueueItem(
    state,
    captureChatOutboxAdmission(state, state.sessionKey, item.agentId),
    item,
  );
}

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => vi.unstubAllGlobals());

describe("chat composer draft presence notifications", () => {
  it("notifies stored outbox subscribers on draft presence transitions and queue writes", () => {
    const state = createState();
    const original = reconnectItem("notify", 1);
    const updated = { ...original, text: "updated message" };
    const listener = vi.fn();
    const unsubscribe = subscribeStoredChatOutboxChanges(listener);

    try {
      expect(persistChatComposerState({ ...state, chatMessage: "draft only" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      // Content-only re-persists stay silent so projection subscribers cannot
      // react by re-persisting a stale pane over the newer draft.
      expect(persistChatComposerState({ ...state, chatMessage: "draft only, edited" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(persistChatComposerState({ ...state, chatMessage: "" })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(2);
      // Goal-only input badges the sidebar without text, so it is a presence transition too.
      const goalOnly = {
        ...state,
        chatMessage: "",
        chatGoalDraftMode: { action: "start" as const },
      };
      expect(persistChatComposerState(goalOnly)).toBe(true);
      expect(listener).toHaveBeenCalledTimes(3);
      expect(persistChatComposerState({ ...goalOnly, chatGoalDraftMode: null })).toBe(true);
      expect(listener).toHaveBeenCalledTimes(4);
      expect(admitItem(state, original)).toBe(true);
      expect(listener).toHaveBeenCalledTimes(5);
      expect(
        updateStoredChatComposerQueueItem(
          state,
          state.sessionKey,
          original,
          updated,
          original.agentId,
        ),
      ).toBe(true);
      expect(listener).toHaveBeenCalledTimes(6);
    } finally {
      unsubscribe();
    }

    expect(
      removeStoredChatComposerQueueItem(
        state,
        state.sessionKey,
        updated.id,
        updated,
        updated.agentId,
      ),
    ).toBe(true);
    expect(listener).toHaveBeenCalledTimes(6);
  });
});
