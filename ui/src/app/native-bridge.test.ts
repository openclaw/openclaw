import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  handleChatDraftChange as applyDraftChange,
  handleChatInputHistoryKey,
  type ChatInputHistoryState,
} from "../pages/chat/input-history.ts";
import { createNativeChatDrafts } from "./native-bridge.ts";

function makeBridge() {
  const callOrder: string[] = [];
  const listeners = new Set<(event: MessageEvent) => void>();
  const bridge = {
    listeners,
    postMessage: vi.fn(() => callOrder.push("post")),
    addEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => {
      callOrder.push("listen");
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => {
      listeners.delete(listener);
    }),
  };
  vi.stubGlobal("chrome", { webview: bridge });
  return { ...bridge, callOrder };
}

function dispatch(bridge: ReturnType<typeof makeBridge>, data: unknown) {
  for (const listener of bridge.listeners) {
    listener({ data } as MessageEvent);
  }
}

afterEach(() => vi.unstubAllGlobals());

let bridge: ReturnType<typeof makeBridge>;
let drafts: ReturnType<typeof createNativeChatDrafts>;
const listener = vi.fn();
beforeEach(() => {
  bridge = makeBridge();
  drafts = createNativeChatDrafts();
  listener.mockClear();
  drafts.subscribe(listener);
});
it("registers the listener before the ready handshake", () => {
  expect(bridge.callOrder).toEqual(["listen", "post"]);
});

it("delivers drafts and ignores invalid messages", () => {
  dispatch(bridge, { type: "draft-text", payload: { text: "hello from native" } });
  dispatch(bridge, { type: "draft-text" });
  dispatch(bridge, { type: "draft-text", payload: { text: 42 } });
  dispatch(bridge, { type: "unknown" });
  dispatch(bridge, null);
  expect(listener).toHaveBeenCalledOnce();
  expect(listener).toHaveBeenCalledWith("hello from native");
});

it("removes the native listener and stops delivery on dispose", () => {
  drafts.dispose();
  dispatch(bridge, { type: "draft-text", payload: { text: "after cleanup" } });
  expect(bridge.listeners.size).toBe(0);
  expect(listener).not.toHaveBeenCalled();
});

it("applies native drafts through the real Chat draft owner", () => {
  const state: ChatInputHistoryState = {
    sessionKey: "s1",
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatLocalInputHistoryBySession: { s1: [{ text: "previous input", ts: 1 }] },
    chatInputHistorySessionKey: null,
    chatInputHistoryItems: null,
    chatInputHistoryIndex: -1,
    chatDraftBeforeHistory: null,
  };
  handleChatInputHistoryKey(state, {
    key: "ArrowUp",
    selectionStart: 0,
    selectionEnd: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 38,
  });
  drafts.subscribe((text) => applyDraftChange(state, text));
  dispatch(bridge, { type: "draft-text", payload: { text: "native injection" } });
  expect(state).toMatchObject({
    chatMessage: "native injection",
    chatInputHistoryIndex: -1,
    chatInputHistoryItems: null,
    chatInputHistorySessionKey: null,
  });
});
