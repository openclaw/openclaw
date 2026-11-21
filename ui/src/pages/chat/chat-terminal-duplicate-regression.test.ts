// @vitest-environment node
// Base-failing regression for #149153: once persisted history owns a run's
// final row, every live copy of that run — the streamed terminal and the
// materialized stream projection — must retire, on both history reload paths
// (page request and cursor delta). On the unfixed build the live copies
// survive the merge beside the persisted row and the reply renders twice.
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { createState } from "./chat-gateway.test-support.ts";
import { handleChatGatewayEvent, type ChatEventPayload } from "./chat-gateway.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatHistoryHost, ChatState } from "./chat-state-contract.ts";
import { publishChatSessionProjectionMessages } from "./history-merge.ts";
import {
  applyChatCacheSnapshot,
  cacheChatSessionSnapshot,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import {
  authoritativeHistoryAppliedForRun,
  rememberAuthoritativeTerminal,
  rememberLiveTerminalRun,
} from "./terminal-message-identity.ts";

// ----- page-request harness (chat-gateway.test.ts conventions) -----

function chatEvent(
  state: ChatEventPayload["state"],
  payload: Omit<ChatEventPayload, "state" | "sessionKey"> & { sessionKey?: string } = {},
): ChatEventPayload {
  return { runId: "run-1", sessionKey: "main", state, ...payload };
}

function receive(state: ChatState, ...args: Parameters<typeof chatEvent>) {
  return handleChatGatewayEvent(state, chatEvent(...args));
}

function textMessage(
  role: "assistant" | "user",
  text: string,
  metadata?: Record<string, unknown>,
  timestamp?: number,
) {
  return {
    role,
    content: [{ type: "text" as const, text }],
    ...(metadata ? { __openclaw: metadata } : {}),
    ...(timestamp === undefined ? {} : { timestamp }),
  };
}

const replyText = textMessage.bind(null, "assistant");
const userText = textMessage.bind(null, "user");

function createTestClient(request: unknown): NonNullable<ChatState["client"]> {
  return { request } as unknown as NonNullable<ChatState["client"]>;
}

function createHistoryState(
  request: unknown,
  overrides: Partial<ChatHistoryHost> = {},
): ChatHistoryHost {
  const state = createState({ client: createTestClient(request), ...overrides });
  const sessions = createTestSessionCapability({
    snapshot: {
      client: state.client,
      phase: state.connected ? "connected" : "reconnecting",
      hello: state.hello,
      sessionKey: state.sessionKey,
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  });
  vi.spyOn(sessions, "listBranches").mockResolvedValue([]);
  onTestFinished(() => sessions.dispose());
  return { ...state, sessions };
}

// ----- cursor-delta harness (chat-history-cursor.test.ts conventions) -----

function createCursorState(handler: (params?: unknown) => unknown) {
  return makeChatHost({
    requestHandlers: { "chat.history": handler },
    sessionKey: "main",
    connectionEpoch: 1,
  });
}

function cursorMessage(
  role: "assistant" | "user",
  content: unknown,
  id: string,
  seq: number,
  metadata: Record<string, unknown> = {},
) {
  return { role, content, __openclaw: { id, seq, ...metadata } };
}

const sessionInfo = (overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow => ({
  key: "main",
  kind: "direct",
  sessionId: "session-cursor",
  updatedAt: 2,
  ...overrides,
});

const persisted = (row: ReturnType<typeof cursorMessage>, extra: Record<string, unknown> = {}) => ({
  message: row,
  messageId: row["__openclaw"].id,
  messageSeq: row["__openclaw"].seq,
  ...extra,
});

function delta(cursor: string, messages: unknown[], row: Partial<GatewaySessionRow> = {}) {
  return { kind: "delta", deltaCursor: cursor, messages, sessionInfo: sessionInfo(row) };
}

function seedCachedHistory(
  state: ReturnType<typeof createCursorState>,
  messages: unknown[],
  deltaCursor?: string,
): ChatMessageCache {
  const cache: ChatMessageCache = new Map();
  state.chatMessagesBySession = cache;
  const snapshot = {
    ...(deltaCursor !== undefined ? { deltaCursor } : {}),
    displayedLeafEntryId: state.chatDisplayedLeafEntryId,
    messages,
    pagination: { hasMore: false, completeSnapshot: true } as const,
    sessionId: "session-cursor",
  };
  applyChatCacheSnapshot(state, snapshot);
  cacheChatSessionSnapshot(cache, state, { sessionKey: state.sessionKey }, snapshot);
  return cache;
}

describe("#149153 live-copy retirement across history reloads", () => {
  it("renders the persisted final exactly once after a mid-run persistence and page reload", async () => {
    const user = userText("Ask", { id: "user-1", seq: 1 });
    const saved = replyText("Final answer", { id: "final-message", seq: 2, runId: "run-1" });
    const live = replyText("Final answer");
    const request = vi.fn().mockResolvedValue({ messages: [user, saved], sessionId: "session-1" });
    const state = createHistoryState(request, {
      chatRunId: "run-1",
      currentSessionId: "session-1",
    });

    // A divergent partial streams while the run is active.
    receive(state, "delta", { message: replyText("Final ans"), replace: true });
    expect(state.chatStream).toBe("Final ans");

    // #149153 timeline: the persisted final lands while the run still reads active.
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      payload: { message: saved, messageId: "final-message" },
      matchesChat: true,
      runIdBeforeApply: "run-1",
    });

    // The gateway settles the run with the streamed copy.
    receive(state, "final", { message: live });
    expect(state.chatMessages.some((row) => row === live)).toBe(true);

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([user, saved]);
    expect(authoritativeHistoryAppliedForRun(state, "run-1", "main")).toBe(true);
  });

  it("retires the live terminal and stream projection once a cursor delta owns the final", async () => {
    const user = cursorMessage("user", "Ask", "user-1", 1);
    const saved = cursorMessage("assistant", "Final answer", "final-message", 2, {
      runId: "run-1",
    });
    const handler = vi.fn(async () =>
      delta("cursor-2", [persisted(saved, { runId: "run-1" })], {
        activeLeafEntryId: "leaf-2",
        updatedAt: 2,
        hasActiveRun: false,
      }),
    );
    const state = createCursorState(handler);
    state.chatDisplayedLeafEntryId = "leaf-1";
    seedCachedHistory(state, [user], "cursor-1");

    // Live copies exactly as the streaming UI holds them: the WeakMap-tagged
    // terminal plus the unkeyed projection of the divergent partial.
    const liveTerminal = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
      "run-1",
    );
    const streamProjection = {
      role: "assistant",
      content: [{ type: "text", text: "Final ans" }],
      openclawStreamFallback: {
        replacementText: "Final answer",
        source: "current",
        runId: "run-1",
      },
    };
    publishChatSessionProjectionMessages(state, [user, liveTerminal, streamProjection], {
      scope: { sessionKey: "main" },
    });

    // The persisted final landed while the run still read active.
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      payload: { message: saved, messageId: "final-message" },
      matchesChat: true,
      runIdBeforeApply: "run-1",
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([user, saved]);
    expect(authoritativeHistoryAppliedForRun(state, "run-1", "main")).toBe(true);
  });

  it("retires both runs' live copies when one page owns both finals", async () => {
    const user = userText("Ask", { id: "user-1", seq: 1 });
    const savedFirst = replyText("First answer", { id: "final-1", seq: 2, runId: "run-1" });
    const savedSecond = replyText("Second answer", { id: "final-2", seq: 4, runId: "run-2" });
    const request = vi.fn().mockResolvedValue({
      messages: [user, savedFirst, savedSecond],
      sessionId: "session-1",
    });
    const state = createHistoryState(request, { currentSessionId: "session-1" });

    const liveFirst = rememberLiveTerminalRun(replyText("First answer"), "run-1");
    const liveSecond = rememberLiveTerminalRun(replyText("Second answer"), "run-2");
    publishChatSessionProjectionMessages(state, [liveFirst, liveSecond], {
      scope: { sessionKey: "main" },
    });

    // Each run's persisted final landed while a later run was still active.
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      payload: { message: savedFirst, messageId: "final-1" },
      matchesChat: true,
      runIdBeforeApply: "run-1",
    });
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-2", hasActiveRun: true },
      payload: { message: savedSecond, messageId: "final-2" },
      matchesChat: true,
      runIdBeforeApply: "run-2",
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([user, savedFirst, savedSecond]);
    expect(authoritativeHistoryAppliedForRun(state, "run-1", "main")).toBe(true);
    expect(authoritativeHistoryAppliedForRun(state, "run-2", "main")).toBe(true);
  });

  it("keeps the post-steer final when the pre-steer row already applied (#149153 P1)", async () => {
    const user = userText("Ask", { id: "user-1", seq: 1 });
    const preSteer = replyText("Before steer.", {
      id: "pre-steer-message",
      seq: 2,
      runId: "run-1",
    });
    const steerRow = userText("Steer", { id: "steer-1", seq: 3, steerTargetRunId: "run-1" });
    const savedFinal = replyText("After steer answer", {
      id: "post-steer-message",
      seq: 4,
      runId: "run-1",
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ messages: [user, preSteer, steerRow], sessionId: "session-1" })
      .mockResolvedValue({
        messages: [user, preSteer, steerRow, savedFinal],
        sessionId: "session-1",
      });
    const state = createHistoryState(request, {
      chatRunId: "run-1",
      currentSessionId: "session-1",
    });

    receive(state, "delta", { message: replyText("Before steer."), replace: true });

    // The pre-steer partial persists while the run still reads active.
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      payload: { message: preSteer, messageId: "pre-steer-message" },
      matchesChat: true,
      runIdBeforeApply: "run-1",
    });

    // The steer triggers the history reload that applies the pre-steer row.
    await loadChatHistory(state);
    expect(authoritativeHistoryAppliedForRun(state, "run-1", "main")).toBe(true);

    // The post-steer final is a new answer, not a replay of the applied row.
    const live = replyText("After steer answer");
    receive(state, "final", { message: live });
    expect(state.chatMessages.some((row) => row === live)).toBe(true);

    // Its own persistence converges back to exactly one copy per row.
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-1", hasActiveRun: false },
      payload: { message: savedFinal, messageId: "post-steer-message" },
      matchesChat: true,
      runIdBeforeApply: "run-1",
    });
    await loadChatHistory(state);
    expect(state.chatMessages).toEqual([user, preSteer, steerRow, savedFinal]);
  });

  it("retires the live copy of a pure-image final (#149153 P2)", async () => {
    const user = userText("Ask", { id: "user-1", seq: 1 });
    const saved = {
      role: "assistant",
      content: [{ type: "image", artifactId: "art-1" }],
      __openclaw: { id: "image-final", seq: 2, runId: "run-1" },
    };
    const request = vi.fn().mockResolvedValue({ messages: [user, saved], sessionId: "session-1" });
    const state = createHistoryState(request, {
      chatRunId: "run-1",
      currentSessionId: "session-1",
    });

    const liveTerminal = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "image", artifactId: "art-1" }] },
      "run-1",
    );
    publishChatSessionProjectionMessages(state, [user, liveTerminal], {
      scope: { sessionKey: "main" },
    });

    // The image-only final persists while the run still reads active.
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      payload: { message: saved, messageId: "image-final" },
      matchesChat: true,
      runIdBeforeApply: "run-1",
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([user, saved]);
    expect(authoritativeHistoryAppliedForRun(state, "run-1", "main")).toBe(true);
  });

  it("keeps the post-steer final when a stale read lands after it published (#149153)", async () => {
    const user = userText("Ask", { id: "user-1", seq: 1 });
    const preSteer = replyText("Before steer.", {
      id: "pre-steer-message",
      seq: 2,
      runId: "run-1",
    });
    const steerRow = userText("Steer", { id: "steer-1", seq: 3, steerTargetRunId: "run-1" });
    const savedFinal = replyText("After steer answer", {
      id: "post-steer-message",
      seq: 4,
      runId: "run-1",
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ messages: [user, preSteer, steerRow], sessionId: "session-1" })
      // Stale reads can repeat: each is served before the post-steer row
      // persists, and none of them may delete the newer final (#149153).
      .mockResolvedValueOnce({ messages: [user, preSteer, steerRow], sessionId: "session-1" })
      .mockResolvedValueOnce({ messages: [user, preSteer, steerRow], sessionId: "session-1" })
      .mockResolvedValue({
        messages: [user, preSteer, steerRow, savedFinal],
        sessionId: "session-1",
      });
    const state = createHistoryState(request, {
      chatRunId: "run-1",
      currentSessionId: "session-1",
    });

    receive(state, "delta", { message: replyText("Before steer."), replace: true });
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      payload: { message: preSteer, messageId: "pre-steer-message" },
      matchesChat: true,
      runIdBeforeApply: "run-1",
    });
    // The steer-triggered reload applies the pre-steer row.
    await loadChatHistory(state);
    expect(authoritativeHistoryAppliedForRun(state, "run-1", "main")).toBe(true);

    // The post-steer final publishes while its own durable row is still in flight.
    const live = replyText("After steer answer");
    receive(state, "final", { message: live });
    expect(state.chatMessages.some((row) => row === live)).toBe(true);

    // The stale read carries only pre-steer rows: its retirement pass must not
    // delete the newer final, whose own durable row has not arrived yet.
    await loadChatHistory(state);
    expect(state.chatMessages.some((row) => row === live)).toBe(true);
    await loadChatHistory(state);
    expect(state.chatMessages.some((row) => row === live)).toBe(true);

    // Its own persistence converges back to exactly one copy per row.
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      payload: { message: savedFinal, messageId: "post-steer-message" },
      matchesChat: true,
      runIdBeforeApply: "run-1",
    });
    await loadChatHistory(state);
    expect(state.chatMessages).toEqual([user, preSteer, steerRow, savedFinal]);
  });

  it("keeps the post-steer final when the first read after its publish is already stale (#149153)", async () => {
    const user = userText("Ask", { id: "user-1", seq: 1 });
    const preSteer = replyText("Before steer.", {
      id: "pre-steer-message",
      seq: 2,
      runId: "run-1",
    });
    const steerRow = userText("Steer", { id: "steer-1", seq: 3, steerTargetRunId: "run-1" });
    const savedFinal = replyText("After steer answer", {
      id: "post-steer-message",
      seq: 4,
      runId: "run-1",
    });
    const request = vi
      .fn()
      // The first read lands already stale: the steer and the newer final
      // both predate its settlement, but its page omits the newer row.
      .mockResolvedValueOnce({ messages: [user, preSteer, steerRow], sessionId: "session-1" })
      .mockResolvedValue({
        messages: [user, preSteer, steerRow, savedFinal],
        sessionId: "session-1",
      });
    const state = createHistoryState(request, {
      chatRunId: "run-1",
      currentSessionId: "session-1",
    });

    // The pre-steer row persists while the run still reads active; no read
    // has applied it yet when the post-steer final publishes.
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      payload: { message: preSteer, messageId: "pre-steer-message" },
      matchesChat: true,
      runIdBeforeApply: "run-1",
    });
    const live = replyText("After steer answer");
    receive(state, "final", { message: live });
    expect(state.chatMessages.some((row) => row === live)).toBe(true);

    // The stale first read promotes the pre-steer row but must still not
    // retire the newer final: its own durable row is not in the page.
    await loadChatHistory(state);
    expect(state.chatMessages.some((row) => row === live)).toBe(true);

    // Its own persistence converges back to exactly one copy per row.
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      payload: { message: savedFinal, messageId: "post-steer-message" },
      matchesChat: true,
      runIdBeforeApply: "run-1",
    });
    await loadChatHistory(state);
    expect(state.chatMessages).toEqual([user, preSteer, steerRow, savedFinal]);
  });

  it("keeps the post-steer final when a stale cursor delta lands after it published (#149153)", async () => {
    const user = cursorMessage("user", "Ask", "user-1", 1);
    const preSteer = cursorMessage("assistant", "Before steer.", "pre-steer-message", 2, {
      runId: "run-1",
    });
    const steerRow = cursorMessage("user", "Steer", "steer-1", 3, {
      steerTargetRunId: "run-1",
    });
    const savedFinal = cursorMessage("assistant", "After steer answer", "post-steer-message", 4, {
      runId: "run-1",
    });
    const handler = vi
      .fn()
      .mockImplementationOnce(async () =>
        delta("cursor-2", [persisted(preSteer)], {
          activeLeafEntryId: "leaf-2",
          updatedAt: 3,
          hasActiveRun: true,
        }),
      )
      // Stale deltas can repeat: each is served before the post-steer row
      // persists, and none of them may delete the newer final (#149153).
      .mockImplementationOnce(async () =>
        delta("cursor-3", [persisted(preSteer)], {
          activeLeafEntryId: "leaf-2",
          updatedAt: 3,
          hasActiveRun: true,
        }),
      )
      .mockImplementationOnce(async () =>
        delta("cursor-4", [persisted(preSteer)], {
          activeLeafEntryId: "leaf-2",
          updatedAt: 3,
          hasActiveRun: true,
        }),
      )
      .mockImplementation(async () =>
        delta("cursor-5", [persisted(savedFinal)], {
          activeLeafEntryId: "leaf-3",
          updatedAt: 4,
          hasActiveRun: false,
        }),
      );
    const state = createCursorState(handler);
    state.chatDisplayedLeafEntryId = "leaf-1";
    seedCachedHistory(state, [user], "cursor-1");

    // The pre-steer row persists while the run still reads active.
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      payload: { message: preSteer, messageId: "pre-steer-message" },
      matchesChat: true,
      runIdBeforeApply: "run-1",
    });
    await loadChatHistory(state);
    expect(authoritativeHistoryAppliedForRun(state, "run-1", "main")).toBe(true);
    expect(state.chatMessages).toEqual([user, preSteer]);

    // The steer persists live, then the post-steer final publishes.
    const live = rememberLiveTerminalRun(
      { role: "assistant", content: [{ type: "text", text: "After steer answer" }] },
      "run-1",
    );
    publishChatSessionProjectionMessages(state, [user, preSteer, steerRow, live], {
      scope: { sessionKey: "main" },
    });

    // The stale delta carries no post-steer row: the newer final must
    // survive it, and it must survive a repeat of that stale delta too.
    await loadChatHistory(state);
    expect(state.chatMessages.some((row) => row === live)).toBe(true);
    await loadChatHistory(state);
    expect(state.chatMessages.some((row) => row === live)).toBe(true);

    // Its own persistence converges back to exactly one copy per row.
    rememberAuthoritativeTerminal({
      host: state,
      event: { key: "main", runId: "run-1", hasActiveRun: true },
      payload: { message: savedFinal, messageId: "post-steer-message" },
      matchesChat: true,
      runIdBeforeApply: "run-1",
    });
    await loadChatHistory(state);
    expect(state.chatMessages).toEqual([user, preSteer, steerRow, savedFinal]);
  });
});
