/* @vitest-environment jsdom */

import { createComponent, createMemo, createSignal, merge } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createRefreshChatPane, nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import { ChatHistoryBoundary } from "./components/chat-history-boundary.tsx";

describe("chat pane history loading", () => {
  it("keeps earlier history disabled while a cached transcript hydrates", async () => {
    const response = createDeferred<ChatHistoryResult>();
    const request = vi.fn((method: string) =>
      method === "chat.history" ? response.promise : Promise.resolve({}),
    );
    const { pane, state } = createRefreshChatPane(createGatewayBrowserClientFixture({ request }));
    const messages = [nativeHistoryMessage(3), nativeHistoryMessage(4)];
    state.chatMessages = messages;
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 4 };
    let refresh!: () => void;
    const { container } = mountSolid(() => {
      const [revision, setRevision] = createSignal(0);
      refresh = () => setRevision((value) => value + 1);
      const pagination = createMemo(() => {
        revision();
        pane.render();
        return pane.chatProps!.historyPagination!;
      });
      return createComponent(ChatHistoryBoundary, merge(pagination));
    });
    const historyAction = (loading: boolean) => {
      refresh();
      flush();
      const button = container.querySelector<HTMLButtonElement>("button")!;
      const label = loading ? "Loading earlier…" : "Show earlier";
      expect(button.disabled).toBe(false);
      expect(button.querySelector('[role="status"]')?.textContent?.trim()).toBe(label);
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.getAttribute("aria-busy")).toBe(String(loading));
      expect(Boolean(button.closest(".chat-history-boundary--loading"))).toBe(loading);
      return button;
    };
    historyAction(false);
    for (const loading of [true, false]) {
      pane.history.loadingOlder = loading;
      flush();
      const button = container.querySelector("button")!;
      expect(button.getAttribute("aria-busy")).toBe(String(loading));
      expect(button.getAttribute("aria-disabled")).toBe(loading ? "true" : null);
      expect(button.disabled).toBe(false);
    }

    const hydration = loadChatHistory(state);
    await vi.waitFor(() => expect(state.chatLoading).toBe(true));
    const loading = historyAction(true);
    expect(loading.getAttribute("aria-disabled")).toBe("true");
    loading.click();
    expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);

    response.resolve({ messages, hasMore: true, nextOffset: 2, totalMessages: 4 });
    await hydration;
    historyAction(false);
  });
});
