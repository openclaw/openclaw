/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-suspension.test/"} */

import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createTestChatPane, connectPaneTestView } from "./chat-pane.test-support.ts";
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
    const lifecycle = Object.assign(pane, { render: () => ({ layout: null }) });
    connectPaneTestView(lifecycle);
    await lifecycle.updateComplete;
    const requestUpdate = vi.spyOn(lifecycle, "requestUpdate");
    const render = vi.spyOn(lifecycle, "render");
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requestUpdate).toHaveBeenCalledOnce();
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      // Parking itself invalidates the view; subsequent hidden minutes stay idle.
      requestUpdate.mockClear();
      render.mockClear();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(requestUpdate).not.toHaveBeenCalled();
      expect(render).not.toHaveBeenCalled();
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await lifecycle.updateComplete;
      expect(render).toHaveBeenCalledOnce();
      requestUpdate.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requestUpdate).toHaveBeenCalledOnce();
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
      const { pane, requestUpdate, state } = createTestChatPane({
        client: { request: vi.fn() } as unknown as GatewayBrowserClient,
        sessions: {} as SessionCapability,
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
      state.handleChatDraftChange = vi.fn((next: string) => {
        state.chatMessage = next;
      });
      connectPaneTestView(lifecycle);
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
        lifecycle.disconnectedCallback();
      }
    }
  });
});
