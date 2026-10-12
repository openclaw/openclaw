/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-suspension.test/"} */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";
import { getChatComposerState, resetChatComposerState } from "./components/chat-composer-state.ts";

afterEach(() => {
  resetChatComposerState();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("chat pane suspension", () => {
  it("pauses minute updates while hidden and refreshes once on return", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const client = new GatewayBrowserClient({ url: "ws://example.test" });
    vi.spyOn(client, "request").mockResolvedValue({});
    const { pane } = createTestChatPane({ client });
    const lifecycle = Object.assign(pane, { render: () => null });
    ChatPaneBase.prototype.connectedCallback.call(lifecycle);
    await lifecycle.updateComplete;
    const requestUpdate = vi.spyOn(lifecycle, "requestUpdate");
    try {
      vi.advanceTimersByTime(60_000);
      expect(requestUpdate).toHaveBeenCalledOnce();
      requestUpdate.mockClear();
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(600_000);
      expect(requestUpdate).not.toHaveBeenCalled();
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      expect(requestUpdate).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(60_000);
      expect(requestUpdate).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
      ChatPaneBase.prototype.disconnectedCallback.call(lifecycle);
    }
  });

  it("commits each retained presentation's live draft before the document can suspend", async () => {
    let visibilityState: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    const presentations = ["first", "second"].map((name) => {
      const { pane, requestUpdate, state } = createTestChatPane({
        client: { request: vi.fn() } as unknown as GatewayBrowserClient,
        sessions: {} as SessionCapability,
      });
      const lifecycle = Object.assign(pane, {
        paneId: "p1",
        presentationId: JSON.stringify(["p1", `agent:main:${name}`]),
        render: () => null,
      });
      const textarea = document.createElement("textarea");
      textarea.value = `${name} draft still being composed 雪`;
      getChatComposerState(lifecycle.presentationId).composerTextarea = textarea;
      state.chatMessage = `${name} draft still being`;
      state.handleChatDraftChange = vi.fn((next: string) => {
        state.chatMessage = next;
      });
      ChatPaneBase.prototype.connectedCallback.call(lifecycle);
      return { lifecycle, requestUpdate, state, textarea };
    });
    try {
      await Promise.all(presentations.map(({ lifecycle }) => lifecycle.updateComplete));
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));

      for (const { requestUpdate, state, textarea } of presentations) {
        expect(state.handleChatDraftChange).toHaveBeenCalledExactlyOnceWith(textarea.value);
        expect(state.chatMessage).toBe(textarea.value);
        expect(requestUpdate).toHaveBeenCalledOnce();
      }
    } finally {
      visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.all(presentations.map(({ lifecycle }) => lifecycle.updateComplete));
      for (const { lifecycle } of presentations) {
        Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
        ChatPaneBase.prototype.disconnectedCallback.call(lifecycle);
      }
    }
  });
});
