/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { createRefreshChatPane, nativeHistoryMessage } from "./chat-pane-history.test-support.ts";
import { createGatewayBrowserClientFixture } from "./chat-pane.test-support.ts";
import { renderChatHistoryBoundary } from "./components/chat-history-boundary.ts";

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
    const container = document.createElement("div");
    const historyAction = () => {
      pane.render();
      render(renderChatHistoryBoundary(pane.chatProps!.historyPagination!), container);
      return container.querySelector<HTMLButtonElement>("button")!;
    };
    expect(historyAction().getAttribute("aria-disabled")).toBe("false");
    expect(historyAction().textContent?.trim()).toBe("Show earlier");

    const hydration = loadChatHistory(state);
    await vi.waitFor(() => expect(state.chatLoading).toBe(true));
    const loading = historyAction();
    expect(loading.getAttribute("aria-disabled")).toBe("true");
    expect(loading.textContent?.trim()).toBe("Loading earlier…");
    expect(loading.getAttribute("aria-label")).toBe("Loading earlier…");
    expect(loading.getAttribute("aria-busy")).toBe("true");
    expect(loading.closest(".chat-history-boundary--loading")).not.toBeNull();
    loading.click();
    expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(1);

    response.resolve({ messages, hasMore: true, nextOffset: 2, totalMessages: 4 });
    await hydration;
    const idle = historyAction();
    expect(idle.getAttribute("aria-disabled")).toBe("false");
    expect(idle.textContent?.trim()).toBe("Show earlier");
    expect(idle.getAttribute("aria-label")).toBe("Show earlier");
    expect(idle.getAttribute("aria-busy")).toBe("false");
    expect(idle.closest(".chat-history-boundary--loading")).toBeNull();
  });
});
