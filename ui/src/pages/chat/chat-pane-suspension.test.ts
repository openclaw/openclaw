/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-suspension.test/"} */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createTestChatPane,
  connectPaneTestView,
  getPaneTestRuntime,
} from "./chat-pane.test-support.ts";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";
import { loadChatComposerState } from "./composer-persistence.ts";
import { handleChatDraftChange } from "./input-history.ts";

afterEach(() => {
  resetChatComposerState();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat pane suspension", () => {
  it("pauses minute updates while hidden and refreshes once on return", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const client = new GatewayBrowserClient({ url: "ws://example.test" });
    vi.spyOn(client, "request").mockResolvedValue({});
    const { pane } = createTestChatPane({ client });
    const lifecycle = Object.assign(pane, { render: () => ({ layout: null }) });
    connectPaneTestView(lifecycle);
    await lifecycle.updateComplete;
    const render = vi.spyOn(lifecycle, "render");
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(render).toHaveBeenCalledOnce();
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      render.mockClear();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(render).not.toHaveBeenCalled();
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await lifecycle.updateComplete;
      expect(render).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(render).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
      lifecycle.disconnectedCallback();
    }
  });

  it("commits each retained presentation's live draft before the document can suspend", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    const presentations = ["first", "second"].map((name) => {
      const { pane, state } = createTestChatPane({
        client: createTestGatewayClient(async () => ({})),
      });
      const lifecycle = Object.assign(pane, {
        paneId: "p1",
        presentationId: JSON.stringify(["p1", `agent:main:${name}`]),
        render: () => ({ layout: null }),
      });
      const textarea = document.createElement("textarea");
      textarea.value = `${name} draft still being composed 雪`;
      getChatComposerState(lifecycle.presentationId).composerTextarea = textarea;
      state.chatMessage = `${name} draft still being`;
      vi.spyOn(state, "handleChatDraftChange");
      const draft = getPaneTestRuntime(pane).chatState.composerDraft;
      connectPaneTestView(lifecycle);
      return { lifecycle, draft, state, textarea };
    });
    try {
      await Promise.all(presentations.map(({ lifecycle }) => lifecycle.updateComplete));
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));

      for (const { draft, state, textarea } of presentations) {
        expect(state.handleChatDraftChange).toHaveBeenCalledExactlyOnceWith(textarea.value);
        expect(state.chatMessage).toBe(textarea.value);
        expect(draft.read().draft).toBe(textarea.value);
      }
    } finally {
      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.all(presentations.map(({ lifecycle }) => lifecycle.updateComplete));
      for (const { lifecycle } of presentations) {
        Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
        lifecycle.disconnectedCallback();
      }
    }
  });

  it("stores an ordinary committed draft on hide before its debounce runs", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("sessionStorage", createStorageMock());
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const client = createTestGatewayClient(async () => ({}));
    const { pane, state } = createTestChatPane({ client });
    const lifecycle = Object.assign(pane, { render: () => ({ layout: null }) });
    Object.assign(state, {
      settings: pane.context.gateway.connection,
      chatMessage: "",
      selectedChatSessionIncognito: false,
    });
    state.handleChatDraftChange = (next, mentions) => handleChatDraftChange(state, next, mentions);
    state.renderLifecycle = pane.chatState.createRenderLifecycle();
    pane.chatState.attach(state);
    connectPaneTestView(lifecycle);
    await lifecycle.updateComplete;
    const persistence = pane.chatState.composerPersistence;
    persistence.start();
    try {
      const draft = "unfinished later draft";
      const textarea = document.createElement("textarea");
      textarea.value = draft;
      getChatComposerState(lifecycle.presentationId).composerTextarea = textarea;
      state.handleChatDraftChange(draft);
      expect(loadChatComposerState(state, state.sessionKey).snapshot?.draft ?? "").toBe("");

      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));

      expect(loadChatComposerState(state, state.sessionKey).snapshot?.draft).toBe(draft);
    } finally {
      Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
      lifecycle.disconnectedCallback();
    }
  });
});
