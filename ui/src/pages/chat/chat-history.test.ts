// @vitest-environment node
import { reduceSessionProjection } from "@openclaw/gateway-client/browser";
import { expect, it, onTestFinished, vi } from "vitest";
import { missingScopeErrorShape } from "../../../../packages/gateway-protocol/src/schema/error-codes.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { SessionsRewindResult } from "../../api/types.ts";
import { rewindChatHistory, switchChatHistoryBranch } from "./chat-history-actions.ts";
import { loadOlderChatHistoryPage, requestChatSessionSnapshot } from "./chat-history-request.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { syncSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import {
  activeHistory as emptyActiveHistory,
  type TestState,
} from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import type { ChatState } from "./chat-state-contract.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachment-reads.ts";
import { getChatSessionProjection, publishChatSessionProjection } from "./history-merge.ts";
import { handleChatDraftChange } from "./input-history.ts";
import {
  cacheChatSessionSnapshot,
  readChatMessagesFromCache,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";

function createState(history: ChatHistoryResult) {
  const state = makeChatHost({ sessionKey: "main", requestHandlers: { "chat.history": history } });
  vi.spyOn(state.sessions, "reconcileMutation").mockResolvedValue({ status: "refreshed" });
  vi.spyOn(state.sessions, "reconcileRunTerminal").mockReturnValue(false);
  vi.spyOn(state.sessions, "listBranches").mockResolvedValue([]);
  return Object.assign(state, {
    connectionEpoch: 1,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    requestUpdate: vi.fn(),
  });
}
function activeHistory(runId: string) {
  const history = emptyActiveHistory(runId);
  history.inFlightRun!.text = "intentionally ignored on web";
  return history;
}
const message = (role: "assistant" | "user", text: string, metadata?: Record<string, unknown>) => ({
  role,
  content: [{ type: "text", text }],
  ...(metadata ? { __openclaw: metadata } : {}),
});
function withSessions<T extends object>(history: ChatHistoryResult, methods: T) {
  const state = createState(history);
  return Object.assign(state, {
    sessions: Object.assign(state.sessions, {
      refreshReplacement: vi.fn(async () => null),
      ...methods,
    }),
  });
}
function cached(state: TestState, messages = state.chatMessages) {
  const cache: ChatMessageCache = new Map();
  state.chatMessagesBySession = cache;
  cacheChatSessionSnapshot(
    cache,
    state,
    { sessionKey: state.sessionKey },
    {
      messages,
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "old-session",
    },
  );
  return () => readChatMessagesFromCache(cache, state, { sessionKey: state.sessionKey });
}
function publishLive(
  state: TestState,
  live: unknown,
  scope: ReturnType<typeof getChatSessionProjection>["scope"] = { sessionKey: state.sessionKey },
) {
  const projection = reduceSessionProjection(getChatSessionProjection(state, scope), {
    type: "messagePersisted",
    message: live,
    scope,
  });
  publishChatSessionProjection(state, projection);
  state.chatMessages = [...projection.messages];
}
function rewindState(history: ChatHistoryResult, response: Promise<SessionsRewindResult>) {
  const state = withSessions(history, { rewind: vi.fn(() => response) });
  return Object.assign(state, {
    handleChatDraftChange: vi.fn((next: string, mentions?: ChatState["chatMentions"]) =>
      handleChatDraftChange(state, next, mentions),
    ),
  });
}
const rewind = (state: ReturnType<typeof rewindState>) =>
  rewindChatHistory(state, "user-entry", new ChatAttachmentReadLifecycle(() => {}));
const previous = { key: "agent:main:previous", agentId: null };
const selected = { key: "agent:main:next", agentId: null };
function subscriptionState(
  unsubscribeMessages: ReturnType<typeof vi.fn>,
  subscribeMessages = vi.fn(async () => selected),
) {
  return Object.assign(withSessions({ messages: [] }, { subscribeMessages, unsubscribeMessages }), {
    sessionKey: selected.key,
    chatSessionMessageSubscriptionRequestedKey: previous.key,
    chatSessionMessageSubscription: previous,
    sessionsError: null as string | null,
  });
}

it("preserves prepared quiet activity through older pages and prefetched snapshots", async () => {
  const result = {
    role: "toolResult",
    toolCallId: "wait",
    toolName: "sessions_yield",
    content: [{ type: "text", text: "Waiting finished" }],
    __openclaw: { id: "wait-result", seq: 3 },
  };
  const state = createState({
    messages: [result],
    activity: [{ messageId: "wait-result", items: [] }],
  });
  const expected = [{ ...result, activity: [] }];
  expect((await loadOlderChatHistoryPage(state, 1))?.messages).toEqual(expected);
  expect(
    await requestChatSessionSnapshot(state.client!, state.sessionKey, state, () => true),
  ).toMatchObject({ kind: "snapshot", snapshot: { messages: expected } });
  expect(result).not.toHaveProperty("activity");
});

it("requests the configured default agent for the global workspace alias", async () => {
  const state = createState({ messages: [] });
  Object.assign(state, {
    sessionKey: "workspace",
    assistantAgentId: "work",
    agentsList: { defaultId: "main", mainKey: "workspace", scope: "global" },
  });
  const request = vi.spyOn(state.client!, "request");
  await loadChatHistory(state);
  expect(request).toHaveBeenCalledWith(
    "chat.history",
    { sessionKey: "workspace", agentId: "main", limit: 80, maxBytes: 256 * 1024 },
    { signal: expect.any(AbortSignal) },
  );
});

it("starts the new subscription before the old unsubscribe settles", async () => {
  const release = createDeferred();
  const state = subscriptionState(vi.fn(() => release.promise));
  const sync = syncSelectedSessionMessageSubscription(state);
  await Promise.resolve();
  expect(state.sessions.unsubscribeMessages).toHaveBeenCalledOnce();
  expect(state.sessions.subscribeMessages).toHaveBeenCalledWith(selected.key, {
    agentId: undefined,
    includeApprovals: true,
  });
  expect(state.chatSessionMessageSubscription).toEqual(previous);
  release.resolve();
  await sync;
  expect(state.chatSessionMessageSubscription).toEqual(selected);
});

it.each([false, true])("retains owned subscriptions when releases fail (both=%s)", async (both) => {
  const release = vi.fn().mockRejectedValueOnce(new Error("previous release failed"));
  if (both) {
    release.mockRejectedValueOnce(new Error("replacement release failed"));
  }
  release.mockResolvedValue(undefined);
  const state = subscriptionState(release);
  await syncSelectedSessionMessageSubscription(state);
  expect(state.chatSessionMessageSubscriptionRequestedKey).toBe(both ? selected.key : previous.key);
  expect(state.chatSessionMessageSubscription).toBe(both ? selected : previous);
  expect(state.sessionsError).toContain("previous release failed");
  expect(release).toHaveBeenNthCalledWith(1, previous);
  expect(release).toHaveBeenNthCalledWith(2, selected);
  if (both) {
    expect(state.sessionsError).toContain("replacement release failed");
    await syncSelectedSessionMessageSubscription(state);
    expect(release).toHaveBeenNthCalledWith(3, previous);
    expect(state.chatSessionMessageSubscriptionRequestedKey).toBe(selected.key);
    expect(state.chatSessionMessageSubscription).toBe(selected);
  }
});

it("retries a stale generation's rejected subscription release", async () => {
  vi.useFakeTimers();
  onTestFinished(() => {
    vi.useRealTimers();
  });
  const stale = { key: "agent:main:stale", agentId: null };
  const pending = createDeferred<typeof stale>();
  const release = vi
    .fn()
    .mockRejectedValueOnce(new Error("stale release failed"))
    .mockResolvedValue(undefined);
  const subscribe = vi.fn(async (key: string) =>
    key === stale.key ? await pending.promise : selected,
  );
  const state = Object.assign(
    withSessions({ messages: [] }, { subscribeMessages: subscribe, unsubscribeMessages: release }),
    {
      sessionKey: stale.key,
      chatSessionMessageSubscriptionRequestedKey: null as string | null,
      chatSessionMessageSubscription: null as typeof stale | null,
    },
  );
  const sync = syncSelectedSessionMessageSubscription(state);
  await Promise.resolve();
  state.sessionKey = selected.key;
  await syncSelectedSessionMessageSubscription(state);
  pending.resolve(stale);
  await vi.runAllTimersAsync();
  await sync;
  expect(state.chatSessionMessageSubscription).toBe(selected);
  expect(release).toHaveBeenNthCalledWith(1, stale);
  await syncSelectedSessionMessageSubscription(state);
  expect(release).toHaveBeenNthCalledWith(2, stale);
  expect(release).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  expect(state.chatSessionMessageSubscription).toBe(selected);
  expect(subscribe).toHaveBeenCalledTimes(2);
});

it("rewinds cached history and restores only valid composer attachments", async () => {
  const kept = message("assistant", "kept prefix");
  const result = {
    editorText: "@Alex edit this",
    editorAttachments: [
      { mimeType: "image/png", data: "aW1hZ2U=" },
      { mimeType: "application/pdf", data: "aW1hZ2U=" },
      { mimeType: "image/png", data: "not base64!!" },
      { mimeType: "image/png", data: "A" },
    ],
  };
  const state = rewindState({ messages: [kept] }, Promise.resolve(result));
  state.sessionKey = "agent:main:rewind";
  state.chatMessages = [message("assistant", "stale tail")];
  state.chatMessage = "@Alex current draft";
  state.chatMentions = [{ profileId: "alex-profile", start: 0, end: 5 }];
  state.chatAttachments = [{ id: "old", mimeType: "image/jpeg", dataUrl: "data:old" }];
  const readCache = cached(state);
  expect(await rewind(state)).toEqual(result);
  expect(state.chatMessage).toBe(result.editorText);
  expect(state.chatMentions).toEqual([]);
  expect(state.chatAttachments).toEqual([
    {
      id: expect.stringMatching(/^att-/),
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,aW1hZ2U=",
    },
  ]);
  expect(state.chatMessages).toEqual([kept]);
  expect(readCache()).toEqual([kept]);
});

it("invalidates a rewind's source cache without changing the newly selected draft", async () => {
  const state = rewindState({ messages: [] }, Promise.resolve({}));
  state.sessionKey = "agent:main:source";
  const source = state.sessionKey;
  cached(state, [message("assistant", "stale source tail")]);
  state.sessions.rewind.mockImplementation(async () => {
    state.sessionKey = "agent:main:next";
    return { editorText: "source draft" };
  });
  expect(await rewind(state)).toBeNull();
  expect(
    readChatMessagesFromCache(state.chatMessagesBySession!, state, { sessionKey: source }),
  ).toEqual([]);
  expect(state.handleChatDraftChange).not.toHaveBeenCalled();
});

it("reconciles committed rewind history without overwriting a replacement draft", async () => {
  const pending = createDeferred<SessionsRewindResult>();
  const canonical = message("assistant", "canonical history after rewind");
  const state = rewindState({ messages: [canonical] }, pending.promise);
  state.chatMessages = [message("assistant", "stale history")];
  const loading = rewind(state);
  state.connectionEpoch += 2;
  state.chatMessage = "new connection draft";
  const attachments = [
    { id: "new", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,bmV3" },
  ];
  state.chatAttachments = attachments;
  pending.resolve({ editorText: "stale rewind draft" });
  expect(await loading).toBeNull();
  expect(state.chatMessage).toBe("new connection draft");
  expect(state.chatAttachments).toEqual(attachments);
  expect(state.chatMessages).toEqual([canonical]);
  expect(state.handleChatDraftChange).not.toHaveBeenCalled();
});

it("retries branch metadata after a reconnect read fails", async () => {
  const state = withSessions(
    { messages: [] },
    {
      listBranches: vi
        .fn()
        .mockRejectedValueOnce(new Error("gateway hiccup"))
        .mockResolvedValue([
          { leafEntryId: "tip", headline: "tip", messageCount: 1, active: true },
        ]),
    },
  );
  state.chatBranchesSessionKey = state.sessionKey;
  state.chatBranchesConnectionEpoch = state.connectionEpoch - 1;
  await loadChatHistory(state);
  expect(state.chatBranchesConnectionEpoch).toBe(state.connectionEpoch - 1);
  await loadChatHistory(state);
  expect(state.sessions.listBranches).toHaveBeenCalledTimes(2);
  expect(state.chatBranchesSessionKey).toBe(state.sessionKey);
  expect(state.chatBranchesConnectionEpoch).toBe(state.connectionEpoch);
  expect(state.chatBranches).toHaveLength(1);
});

it("rejects in-flight history after switching branches on the same session", async () => {
  const pending = createDeferred<ChatHistoryResult>();
  const old = message("assistant", "private old branch");
  const next = message("assistant", "selected branch");
  const state = withSessions(
    { messages: [next] },
    { listBranches: vi.fn().mockResolvedValue([]), switchBranch: vi.fn().mockResolvedValue({}) },
  );
  state.sessionKey = "agent:main:branches";
  state.chatMessages = [old];
  const request = vi
    .spyOn(state.client!, "request")
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ messages: [next] });
  const loading = loadChatHistory(state);
  expect(request).toHaveBeenCalledOnce();
  await expect(switchChatHistoryBranch(state, "selected-leaf")).resolves.toBe(true);
  expect(request).toHaveBeenCalledTimes(2);
  expect(state.chatMessages).toEqual([next]);
  pending.resolve({ messages: [old] });
  await loading;
  expect(request).toHaveBeenCalledTimes(2);
  expect(state.chatMessages).toEqual([next]);
});

it("reconciles a committed branch switch after a same-client reconnect", async () => {
  const pending = createDeferred<object>();
  const next = message("assistant", "selected branch after reconnect");
  const state = withSessions(
    { messages: [next] },
    { listBranches: vi.fn().mockResolvedValue([]), switchBranch: vi.fn(() => pending.promise) },
  );
  state.chatMessages = [message("assistant", "stale branch")];
  const loading = switchChatHistoryBranch(state, "stale-leaf");
  state.connectionEpoch += 2;
  pending.resolve({});
  await expect(loading).resolves.toBe(false);
  expect(state.chatMessages).toEqual([next]);
});

it("coalesces stale history while distinct peer messages update the transcript", async () => {
  const pending = createDeferred<ChatHistoryResult>();
  const first = message("user", "shared prompt", { id: "web", idempotencyKey: "web:user", seq: 1 });
  const second = message("user", "shared prompt", {
    id: "tui",
    idempotencyKey: "tui:user",
    seq: 2,
  });
  const reply = message("assistant", "finished reply", { id: "reply", seq: 3 });
  const state = createState({ messages: [reply], sessionId: "session" });
  state.currentSessionId = "session";
  state.chatDisplayedLeafEntryId = undefined;
  state.chatMessages = [reply];
  const scope = { sessionKey: state.sessionKey, sessionId: "session", activeLeafEntryId: null };
  const request = vi.spyOn(state.client!, "request").mockReturnValue(pending.promise);
  publishLive(state, first, scope);
  const firstLoad = loadChatHistory(state);
  publishLive(state, second, scope);
  const secondLoad = loadChatHistory(state);
  expect(request).toHaveBeenCalledOnce();
  expect(state.chatMessages).toEqual([first, second, reply]);
  pending.resolve({ messages: [reply], sessionId: "session" });
  await Promise.all([firstLoad, secondLoad]);
  expect(request).toHaveBeenCalledOnce();
  expect(state.chatMessages).toEqual([first, second, reply]);
});

it.each([
  { previousLeaf: null, nextLeaf: "next-leaf" },
  { previousLeaf: "previous-leaf", nextLeaf: null },
])(
  "never leaks transcript rows across $previousLeaf -> $nextLeaf",
  async ({ previousLeaf, nextLeaf }) => {
    const next = message("user", "selected branch", { id: "next", seq: 5 });
    const state = createState({
      messages: [next],
      hasMore: true,
      nextOffset: 2,
      totalMessages: 6,
      sessionInfo: {
        key: "main",
        kind: "direct",
        updatedAt: 1,
        sessionId: "session",
        activeLeafEntryId: nextLeaf,
      },
    });
    state.currentSessionId = "session";
    state.chatDisplayedLeafEntryId = previousLeaf;
    state.chatHistoryPagination = { hasMore: true, nextOffset: 2, totalMessages: 5 };
    state.chatMessages = [
      message("user", "private previous branch", { id: "previous", seq: 4 }),
      message("user", "private pending", { idempotencyKey: "old:user" }),
    ];
    publishLive(state, message("assistant", "private live reply", { id: "live", seq: 5 }), {
      sessionKey: state.sessionKey,
      sessionId: "session",
      activeLeafEntryId: previousLeaf,
    });
    await loadChatHistory(state);
    expect(state.chatMessages).toEqual([next]);
    expect(state.chatDisplayedLeafEntryId).toBe(nextLeaf);
  },
);

it("does not restore a hidden live assistant from an older snapshot", async () => {
  const state = createState({ messages: [] });
  publishLive(state, message("assistant", "NO_REPLY", { id: "hidden", seq: 1 }));
  await loadChatHistory(state);
  expect(state.chatMessages).toEqual([]);
});

it("clears live projection ownership after history access is denied", async () => {
  const state = createState({ messages: [] });
  const scopeError = missingScopeErrorShape({
    missingScope: "operator.read",
    requiredScopes: ["operator.read"],
  });
  vi.spyOn(state.client!, "request")
    .mockRejectedValueOnce(new GatewayRequestError(scopeError))
    .mockResolvedValueOnce({ messages: [] });
  publishLive(state, message("user", "private prompt", { id: "private", seq: 1 }));
  await loadChatHistory(state);
  expect(state.chatMessages).toEqual([]);
  await loadChatHistory(state);
  expect(state.chatMessages).toEqual([]);
});

it("materializes live commentary when history replaces active tool activity", async () => {
  const result = { role: "toolResult", toolCallId: "call-1", content: "tool output", timestamp: 3 };
  const state = createState({
    ...activeHistory("run-live"),
    messages: [{ role: "user", content: "do it", timestamp: 1 }, result],
  });
  state.chatRunId = "run-live";
  state.settings = { ...state.settings, chatPersistCommentary: false };
  state.chatStreamSegments = [{ text: "Checking the workspace", ts: 2, itemId: "preamble-live" }];
  state.toolStreamOrder = ["call-1"];
  state.toolStreamById.set("call-1", {
    toolCallId: "call-1",
    runId: "run-live",
    name: "read",
    startedAt: 2,
    receivedAt: 2,
    message: result,
  });
  state.chatToolMessages = [result];
  await loadChatHistory(state);
  expect(state.chatMessages).toContainEqual(
    expect.objectContaining({
      openclawStreamFallback: expect.objectContaining({ itemId: "preamble-live" }),
    }),
  );
  expect(state.chatStreamSegments).toEqual([]);
});

it("keeps a foreground tool when history persists a sibling's identical call id", async () => {
  const toolCallId = "call-shared";
  const foreground = buildToolStreamIdentity("run-foreground", toolCallId);
  const background = buildToolStreamIdentity("run-background", toolCallId);
  const result = {
    role: "toolResult",
    runId: "run-background",
    toolCallId,
    content: "background complete",
    timestamp: 4,
  };
  const state = createState({
    ...activeHistory("run-foreground"),
    messages: [{ role: "user", content: "do it", timestamp: 1 }, result],
  });
  state.chatRunId = "run-foreground";
  state.chatStream = "foreground still running";
  state.chatStreamStartedAt = 5;
  function addTool(
    runId: string,
    name: string,
    args: Record<string, string>,
    startedAt: number,
    resultReceived = false,
  ) {
    const toolMessage = {
      role: "assistant",
      runId,
      toolCallId,
      content: [{ type: "toolcall", name, arguments: args }],
    };
    state.toolStreamById.set(buildToolStreamIdentity(runId, toolCallId), {
      toolCallId,
      runId,
      name,
      startedAt,
      receivedAt: startedAt,
      resultReceived,
      message: toolMessage,
    });
    return toolMessage;
  }
  const foregroundMessage = addTool("run-foreground", "read", { path: "foreground.txt" }, 2);
  const backgroundMessage = addTool("run-background", "exec", { command: "background" }, 3, true);
  state.toolStreamOrder = [foreground, background];
  state.chatToolMessages = [foregroundMessage, backgroundMessage];
  const foregroundSegment = {
    text: "before foreground",
    ts: 2,
    runId: "run-foreground",
    toolCallId,
  };
  state.chatStreamSegments = [
    foregroundSegment,
    { text: "before background", ts: 3, runId: "run-background", toolCallId },
  ];
  await loadChatHistory(state);
  expect(state.chatRunId).toBe("run-foreground");
  expect(state.chatStream).toBe("foreground still running");
  expect(state.toolStreamOrder).toEqual([foreground]);
  expect(state.toolStreamById.has(foreground)).toBe(true);
  expect(state.toolStreamById.has(background)).toBe(false);
  expect(state.chatToolMessages).toEqual([foregroundMessage]);
  expect(state.chatStreamSegments).toEqual([foregroundSegment]);
});
