/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import {
  createRefreshChatPane,
  createTestChatPane,
  nativeHistoryMessage,
} from "./chat-pane-history.test-support.ts";
import { flushDeferredRowPrune } from "./components/chat-transcript.test-support.ts";

const sourceId = "source-message";
const message = { role: "assistant", content: "Original answer", __openclaw: { id: sourceId } };
const pair = (last: number) => [last - 1, last].map((seq) => nativeHistoryMessage(seq));

it("revises reply access only when final message or availability facts change", () => {
  const { pane, state } = createRefreshChatPane();
  onTestFinished(() => pane.chatProps?.transcript.dispose());
  const access = () => {
    pane.render();
    return expectDefined(pane.chatProps?.replyMessageAccess, "reply access");
  };
  const reply = (
    id: string,
    result?: { ok: boolean; message?: unknown; unavailableReason?: string },
  ) => ({
    role: "user",
    content: "Follow-up",
    timestamp: 1,
    __openclaw: { replyToId: id, replyToMessage: result },
  });
  const original = { role: "assistant", content: "Original" };
  const replacement = { ...original };
  const cases = [
    { messages: [], revision: 0, status: "pending", body: undefined },
    {
      messages: [reply("source", { ok: true, message: original })],
      revision: 1,
      status: undefined,
      body: original,
    },
    {
      messages: [reply("source", { ok: true, message: original })],
      revision: 1,
      status: undefined,
      body: original,
    },
    {
      messages: [reply("other", { ok: false }), reply("source", { ok: true, message: original })],
      revision: 2,
      status: undefined,
      body: original,
    },
    {
      messages: [reply("source", { ok: true, message: original }), reply("other", { ok: false })],
      revision: 2,
      status: undefined,
      body: original,
    },
    {
      messages: [
        reply("source", { ok: false, unavailableReason: "oversized" }),
        reply("other", { ok: false }),
        reply("source", { ok: true, message: original }),
      ],
      revision: 2,
      status: undefined,
      body: original,
    },
    {
      messages: [
        reply("other", { ok: false }),
        reply("source", { ok: true, message: replacement }),
      ],
      revision: 3,
      status: undefined,
      body: replacement,
    },
    {
      messages: [reply("other", { ok: false }), reply("source", { ok: false })],
      revision: 4,
      status: "missing",
      body: undefined,
    },
    {
      messages: [
        reply("other", { ok: false }),
        reply("source", { ok: false, unavailableReason: "oversized" }),
      ],
      revision: 5,
      status: "oversized",
      body: undefined,
    },
    {
      messages: [reply("other", { ok: false }), reply("source")],
      revision: 6,
      status: "pending",
      body: undefined,
    },
    { messages: [], revision: 7, status: "pending", body: undefined },
    { messages: [], revision: 7, status: "pending", body: undefined },
  ];
  for (const entry of cases) {
    state.chatMessages = entry.messages;
    const current = access();
    expect(current.read("source")).toBe(entry.body);
    expect(current.status?.("source")).toBe(entry.status);
    expect(current.revision).toBe(entry.revision);
  }
});

it("invalidates retired reply facts while preserving them across a connection epoch change", () => {
  const { pane, state } = createRefreshChatPane();
  onTestFinished(() => pane.chatProps?.transcript.dispose());
  const source = { role: "assistant", content: "Held original" };
  const followup = {
    role: "user",
    content: "Follow-up",
    __openclaw: { replyToId: "source", replyToMessage: { ok: true, message: source } },
  };
  const access = () => {
    pane.render();
    return expectDefined(pane.chatProps?.replyMessageAccess, "reply access");
  };
  state.chatMessages = [followup];
  const held = access();
  expect(held.read("source")).toBe(source);
  state.connectionEpoch += 1;
  expect(access().revision).toBe(held.revision);
  expect(access().read("source")).toBe(source);
  state.chatMessages = [];
  expectDefined(state.transcriptMessagesRetired, "retirement callback")([followup]);
  const retired = access();
  expect(retired.read("source")).toBeUndefined();
  expect(retired.status?.("source")).toBe("pending");
  expect(retired.revision).toBe(held.revision + 1);
  state.transcriptMessagesRetired?.([]);
  expect(access().revision).toBe(retired.revision);
  state.chatMessages = [followup];
  const restored = access();
  expect(restored.read("source")).toBe(source);
  expect(restored.revision).toBe(retired.revision + 1);
});
const page = (messages: unknown[], totalMessages = 4, hasMore = false, nextOffset?: number) => ({
  messages,
  totalMessages,
  hasMore,
  ...(nextOffset === undefined ? {} : { olderCursor: `older-${nextOffset}` }),
});

function fixture(request = vi.fn(), last = 4) {
  const result = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
    sessions: {} as SessionCapability,
  });
  result.state.currentSessionId = "reply-session";
  result.state.chatMessages = pair(last);
  result.state.chatHistoryPagination = {
    hasMore: true,
    olderCursor: "older-2",
    totalMessages: last,
  };
  return result;
}

it.each([
  { result: { ok: true, message }, expected: undefined },
  { result: undefined, expected: "pending" },
  { result: { ok: false, unavailableReason: "oversized" }, expected: "oversized" },
  { result: { ok: false, unavailableReason: "not_found" }, expected: "missing" },
])("keeps reply availability through reconnect ($expected)", ({ result, expected }) => {
  const request = vi.fn();
  const { pane, state } = fixture(request);
  state.chatMessages = [
    {
      role: "user",
      content: "Follow-up",
      __openclaw: { replyToId: sourceId, replyToMessage: result },
    },
  ];
  expect(pane.replyMessageStatus(sourceId)).toBe(expected);
  expect(pane.readReplyMessage(sourceId)).toBe(result?.message);
  pane.connectionGeneration += 1;
  state.connectionEpoch = pane.connectionGeneration;
  expect(pane.readReplyMessage(sourceId)).toBe(result?.message);
  expect(state.chatMessages).toHaveLength(1);
  expect(request).not.toHaveBeenCalled();
  state.chatMessages = [];
  expect(pane.readReplyMessage(sourceId)).toBeUndefined();
});

it.each([true, false])(
  "finds paginated replies or reports exhaustion (found: %s)",
  async (found) => {
    const target = {
      ...nativeHistoryMessage(1, "Original answer"),
      __openclaw: { id: sourceId, seq: 1 },
    };
    const request = vi.fn();
    request.mockResolvedValueOnce({
      messages: found ? [target] : [],
      sessionId: "reply-session",
      ...(found ? {} : { windowReset: true }),
    });
    if (!found) {
      request.mockResolvedValueOnce({
        ...page(pair(4), 4, true, 2),
        sessionId: "reply-session",
      });
    }
    const { pane, state } = fixture(request, found ? 6 : 4);
    const messageId = found ? sourceId : "missing-message";
    vi.spyOn(pane, "updateComplete", "get").mockReturnValue(Promise.resolve(true));
    const revealMessage = vi.spyOn(pane.transcript, "revealMessage").mockReturnValue(true);
    void pane.openReplyMessage(messageId);
    if (found) {
      expect(pane.currentReplyNavigationId(state.sessionKey)).toBe(sourceId);
      await vi.waitFor(() => expect(revealMessage).toHaveBeenCalledWith(sourceId));
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "chat.history",
        {
          sessionKey: state.sessionKey,
          sessionId: "reply-session",
          messageId: sourceId,
          limit: 1,
          maxBytes: 256 * 1024,
          toolResultMaxChars: 2_000,
        },
        { signal: expect.any(AbortSignal) },
      );
    } else {
      await vi.waitFor(() => expect(state.lastError).toBe("The original message is unavailable."));
      expect(revealMessage).not.toHaveBeenCalled();
    }
    expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
  },
);

it("abandons reply navigation when the pane switches sessions", async () => {
  const deferred = createDeferred<ReturnType<typeof page>>();
  const request = vi.fn(() => deferred.promise);
  const { pane, state } = fixture(request);
  const revealMessage = vi.spyOn(pane.transcript, "revealMessage");
  void pane.openReplyMessage(sourceId);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  state.sessionKey = "agent:main:other";
  pane.resetOlderMessagesViewport();
  deferred.resolve(page([]));
  await deferred.promise;
  await flushDeferredRowPrune();
  expect(pane.currentReplyNavigationId(state.sessionKey)).toBeNull();
  expect(revealMessage).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledOnce();
});

it.each(["session", "agent", "connection"])(
  "retires a held reply reset across a successor %s",
  async (successor) => {
    const deferred = createDeferred<ReturnType<typeof page>>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ messages: [], windowReset: true })
      .mockImplementationOnce(() => deferred.promise);
    const { pane, state } = fixture(request);
    const reveal = vi.spyOn(pane.transcript, "revealMessage");
    if (successor === "agent") {
      state.sessionKey = "global";
      state.assistantAgentId = "main";
    }
    const navigation = pane.openReplyMessage(sourceId);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    if (successor === "session") {
      state.sessionKey = "agent:main:other";
    } else if (successor === "agent") {
      state.assistantAgentId = "other";
    } else {
      state.connectionEpoch += 1;
    }
    state.lastError = "successor error";
    deferred.resolve(page(pair(4)));
    await navigation;
    expect(state.lastError).toBe("successor error");
    expect(reveal).not.toHaveBeenCalled();
  },
);

it("makes a reply lookup superseded by same-session history visibly retryable", async () => {
  const deferred = createDeferred<ReturnType<typeof page>>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => deferred.promise)
    .mockResolvedValueOnce({ ...page(pair(4)), sessionId: "reply-session" });
  const { pane, state } = fixture(request);
  const navigation = pane.openReplyMessage(sourceId);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const { loadChatHistory } = await import("./chat-history.ts");
  await loadChatHistory(state, { deferBranches: true, supersedeInFlight: true });
  deferred.resolve(page([]));
  await navigation;
  expect(state.lastError).toBe("History refreshed before this page loaded. Try again.");
});
