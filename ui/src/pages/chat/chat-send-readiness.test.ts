// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { loadChatHistory } from "./chat-history.ts";
import { findChatSendPayload, makeChatHost } from "./chat-host.test-support.ts";
import { handleSendChat } from "./chat-send-submit.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { applyChatCacheSnapshot } from "./session-message-cache.ts";

beforeEach(() => {
  installOutboxBrowserStorage();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps a restored transcript draft unsent until initial history commits", async () => {
  const history = createDeferred<ChatHistoryResult>();
  const current: ChatHistoryResult = {
    sessionId: "current-session",
    messages: [],
    sessionInfo: {
      key: "agent:main:main",
      sessionId: "current-session",
      kind: "direct",
      updatedAt: 1,
    },
  };
  const host = makeChatHost({
    chatMessage: "Draft while restoring history",
    requestHandlers: {
      "chat.startup": () => history.promise,
      "chat.history": current,
      "chat.send": { status: "started" },
    },
  });
  applyChatCacheSnapshot(host, {
    messages: [],
    sessionId: "restored-session",
    pagination: { hasMore: false, completeSnapshot: true },
  });
  const loading = loadChatHistory(host, { startup: true, deferBranches: true });
  await handleSendChat(host);
  expect(host.currentSessionId).toBe("restored-session");
  expect(host.chatMessage).toBe("Draft while restoring history");
  expect(host.chatQueue).toEqual([]);
  expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
  expect(host.request).not.toHaveBeenCalledWith("chat.history", expect.anything());
  history.resolve(current);
  await loading;
  expect(host.request).not.toHaveBeenCalledWith("chat.send", expect.anything());
  await handleSendChat(host);
  expect(findChatSendPayload(host)).toMatchObject({
    message: "Draft while restoring history",
    sessionId: "current-session",
  });
});
