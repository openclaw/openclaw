import { reduceSessionProjection } from "@openclaw/gateway-client/browser";
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { missingScopeErrorShape } from "../../../../packages/gateway-protocol/src/schema/error-codes.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { handleChatGatewayEvent, type ChatEventPayload } from "./chat-gateway.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
import type { ChatHistoryHost, ChatState } from "./chat-state-contract.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjection,
  publishChatSessionProjectionMessages,
} from "./history-merge.ts";
import {
  reconcileChatRunAfterSessionStatePublication,
  type ChatRunUiStatus,
} from "./run-lifecycle.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { cacheChatSessionSnapshot, readChatMessagesFromCache } from "./session-message-cache.ts";
import {
  visibleAssistantStreamParts,
  visibleCurrentAssistantStreamTail,
} from "./stream-reconciliation.ts";
import {
  authoritativeHistoryAppliedForRun,
  reconcileAuthoritativeTerminalHistory,
  rememberAuthoritativeTerminal,
  rememberLiveTerminalRun,
} from "./terminal-message-identity.ts";
import type { ToolStreamHost } from "./tool-stream-contract.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";
import { createHost } from "./tool-stream.test-helpers.ts";
import { handleAgentEvent } from "./tool-stream.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function chatEvent(
  state: ChatEventPayload["state"],
  payload: Omit<ChatEventPayload, "state" | "sessionKey"> & { sessionKey?: string } = {},
): ChatEventPayload {
  return { runId: "run-1", sessionKey: "main", state, ...payload };
}

function receive(state: ChatState, ...args: Parameters<typeof chatEvent>) {
  return handleChatGatewayEvent(state, chatEvent(...args));
}

function visibleParts(state: ChatState, includeCurrent = false) {
  return visibleAssistantStreamParts(state, { includeCurrent, isHiddenStreamText: () => false });
}

function expectSettled(state: ChatState) {
  expect(state.chatRunId).toBeNull();
  expect(state.chatStream).toBeNull();
  expect(state.chatStreamStartedAt).toBeNull();
}

function createState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    chatAttachments: [],
    chatHistoryPagination: { hasMore: false },
    chatLoading: false,
    chatMessage: "",
    chatMessages: [],
    chatQueue: [],
    chatRunId: null,
    chatSending: false,
    chatStream: null,
    chatStreamStartedAt: null,
    chatRunStartup: null,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    client: null,
    connected: true,
    connectionEpoch: 0,
    hello: null,
    lastError: null,
    sessionKey: "main",
    ...overrides,
  };
}

it.each([
  { persistedFirst: false, transformed: false },
  { persistedFirst: true, transformed: true },
])(
  "settles a saved interrupted partial once with both error emitters (persisted first=$persistedFirst, transformed=$transformed)",
  ({ persistedFirst, transformed }) => {
    const runId = "interrupted-run";
    const text = "The saved partial reply should appear once.";
    const user = textMessage("user", "Ask", { id: "user", seq: 1, runId });
    const saved = {
      role: "assistant",
      content: transformed
        ? [
            { type: "text", text: "Saved transformed text" },
            { type: "image", source: { type: "url", url: "https://example.test/proof.png" } },
          ]
        : [{ type: "text", text }],
      stopReason: "error",
      __openclaw: {
        id: "saved",
        seq: 2,
        runId,
        mirrorOrigin: "codex-app-server",
        idempotencyKey: "saved-key",
      },
    };
    const state = createState({ chatMessages: [user], chatRunId: runId });
    receive(state, "delta", { runId, seq: 12, message: textMessage("assistant", text) });
    const persist = () =>
      applySessionMessagePayload(state, { runId, message: saved }, true, { kind: "history-delta" });
    if (persistedFirst) {
      persist();
    }
    receive(state, "error", {
      runId,
      seq: 13,
      errorMessage: "codex app-server client closed before turn completed",
      message: textMessage("assistant", text, { runId, idempotencyKey: "saved-key" }),
    });
    receive(state, "error", { runId, seq: 1, errorMessage: "Outer returned failure" });
    if (!persistedFirst) {
      persist();
    }
    expect(state.chatMessages).toEqual([user, saved]);
    expect(state.chatRunError?.summary).toBeTruthy();
    const restored = createState({ chatMessages: structuredClone(state.chatMessages) });
    applySessionMessagePayload(restored, { runId, message: saved }, true, {
      kind: "history-delta",
    });
    expect(restored.chatMessages).toEqual([user, saved]);
  },
);

it("preserves receipt-less fallback ownership across cache before matching persistence", () => {
  const runId = "unreceipted-run";
  const user = textMessage("user", "Ask", { id: "user", seq: 1, runId });
  const state = createState({ chatMessages: [user], chatRunId: runId, chatStream: "Partial" });
  receive(state, "error", { runId, seq: 13, errorMessage: "Interrupted" });
  const cached = structuredClone(state.chatMessages);
  const restored = createState({ chatMessages: cached });
  expect(getChatSessionProjection(restored).entries[1]).toMatchObject({
    live: true,
    pending: false,
    afterSequence: 1,
    identity: { runId },
  });
  const prior = textMessage("assistant", "Partial", {
    id: "prior",
    seq: 2,
    runId: "prior-run",
    runTerminal: true,
  });
  applySessionMessagePayload(restored, { message: prior }, true, { kind: "history-delta" });
  expect(restored.chatMessages).toHaveLength(3);
  const current = { ...prior, __openclaw: { id: "current", seq: 3, runId, runTerminal: true } };
  applySessionMessagePayload(restored, { message: current }, true, { kind: "history-delta" });
  expect(restored.chatMessages).toEqual([user, prior, current]);
});

it.each([false, true])(
  "completes an overtaken commentary item with formatting (persisted=%s)",
  (persisted) => {
    const text = "- first file\n- second file\n\n```python\n    execute()\n```";
    const state = Object.assign(
      createState(),
      createHost({
        chatRunId: "run-1",
        chatStream: text.slice(0, -4),
      }),
    );
    handleAgentEvent(state, {
      sessionKey: "main",
      runId: "run-1",
      seq: 1,
      ts: 1,
      stream: "item",
      data: {
        kind: "preamble",
        phase: "end",
        itemId: "commentary-1",
        progressText: text.replace(/\s+/gu, " "),
      },
    });
    expect(
      visibleParts(state, true).map((part) => ({ text: part.text, itemId: part.itemId })),
    ).toEqual([{ text: text.replace(/\s+/gu, " "), itemId: "commentary-1" }]);
    if (persisted) {
      // Durable history projects the transcript text, not flattened progressText.
      applySessionMessagePayload(
        state,
        {
          runId: "run-1",
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            __openclaw: { id: "saved-commentary", seq: 1, runId: "run-1" },
            openclawStreamFallback: { source: "segment", itemId: "commentary-1" },
          },
        },
        true,
        { kind: "history-delta" },
      );
      expect(state.chatMessages.map(extractText)).toEqual([text]);
    }
    receive(state, "delta", { seq: 2, message: textMessage("assistant", text) });
    expect(
      visibleParts(state, true).map((part) => ({ text: part.text, itemId: part.itemId })),
    ).toEqual(persisted ? [] : [{ text, itemId: "commentary-1" }]);
    if (persisted) {
      expect(state.chatMessages.map(extractText)).toEqual([text]);
    }
    expect(state.chatStream).toBe(text);
  },
);

type HistoryResult = {
  messages: Array<unknown>;
  thinkingLevel?: string;
  verboseLevel?: string;
};

function createTestClient(request: unknown): NonNullable<ChatState["client"]> {
  return { request } as unknown as NonNullable<ChatState["client"]>;
}

function createHistoryState(
  request: unknown,
  overrides: Partial<ChatHistoryHost> = {},
): ChatHistoryHost {
  return createHistoryStateForClient(createTestClient(request), overrides);
}

function createResolvedHistoryState(result: unknown, overrides: Partial<ChatHistoryHost> = {}) {
  const request = vi.fn().mockResolvedValue(result);
  return { request, state: createHistoryState(request, overrides) };
}

function createHistorySnapshot(messages: Array<unknown>, overrides: Partial<ChatHistoryHost> = {}) {
  return createResolvedHistoryState({ messages, thinkingLevel: "low" }, overrides);
}

function createHistoryStateForClient(
  client: NonNullable<ChatState["client"]>,
  overrides: Partial<ChatHistoryHost> = {},
): ChatHistoryHost {
  const state = createState({ client, ...overrides });
  if (overrides.sessions) {
    return { ...state, sessions: overrides.sessions };
  }
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

function createDeferredHistoryState(overrides: Partial<ChatHistoryHost> = {}) {
  const history = createDeferred<HistoryResult>();
  const request = vi.fn(() => history.promise);
  return { history, request, state: createHistoryState(request, overrides) };
}

function createAssistantHistory(text: string, overrides: Omit<HistoryResult, "messages"> = {}) {
  return {
    messages: [textMessage("assistant", text)],
    ...overrides,
  };
}

function seedChatSnapshot(
  state: ChatState,
  target: { sessionKey: string; agentId?: string },
): void {
  if (!state.chatMessagesBySession) {
    throw new Error("expected chat message cache");
  }
  cacheChatSessionSnapshot(state.chatMessagesBySession, state, target, {
    messages: [],
    pagination: { hasMore: false, completeSnapshot: true },
    sessionId: "cached-session",
  });
}

type SessionTestState = ChatState & {
  [key: string]: unknown;
  chatRunStatus?: ChatRunUiStatus | null;
  knownAgentRunIds: Set<string>;
  sessionsResult: SessionsListResult;
};

function createStateWithRunningSession(overrides: Partial<ChatState>): SessionTestState {
  const runId = overrides.chatRunId ?? "run-1";
  return {
    ...createState(overrides),
    knownAgentRunIds: new Set([runId]),
    sessionsResult: {
      ts: 0,
      path: "",
      count: 1,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [
        {
          key: "main",
          kind: "direct",
          updatedAt: 1,
          hasActiveRun: true,
          activeRunIds: [runId],
          status: "running",
          startedAt: 100,
        },
      ],
    },
  };
}

type HistoryToolSegment = { text: string; ts: number; toolCallId?: string };
type LiveToolState = ChatHistoryHost &
  Pick<ToolStreamHost, "toolStreamById" | "toolStreamOrder"> & {
    chatStreamSegments: HistoryToolSegment[];
    chatToolMessages: Record<string, unknown>[];
    toolStreamSyncTimer: number | null;
  };

function attachLiveToolState(
  state: ChatHistoryHost,
  tools: Record<string, unknown>[],
  segments: HistoryToolSegment[],
): LiveToolState {
  const liveState = state as LiveToolState;
  liveState.chatStreamSegments = segments;
  liveState.chatToolMessages = tools;
  liveState.toolStreamById = new Map(
    tools.map((tool) => {
      const toolCallId = String(tool.toolCallId);
      const runId = typeof tool.runId === "string" ? tool.runId : (state.chatRunId ?? "run-1");
      return [
        buildToolStreamIdentity(runId, toolCallId),
        {
          toolCallId,
          runId,
          message: tool,
          name: "shell",
          startedAt: 0,
          receivedAt: 0,
        },
      ];
    }),
  );
  liveState.toolStreamOrder = [...liveState.toolStreamById.keys()];
  liveState.toolStreamSyncTimer = null;
  return liveState;
}

function createLiveToolHistoryState(
  messages: Array<unknown>,
  overrides: Partial<ChatHistoryHost>,
  tools: Record<string, unknown>[],
  segments: HistoryToolSegment[],
): LiveToolState {
  return attachLiveToolState(createHistorySnapshot(messages, overrides).state, tools, segments);
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function expectTextMessage(message: unknown, role: string, text: string): void {
  const record = requireRecord(message);
  expect(record.role).toBe(role);
  expect(record.content).toEqual([{ type: "text", text }]);
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

function projectChatMessageEvent(
  state: ChatState,
  event:
    | { type: "sendPending"; runId: string; message: unknown }
    | { type: "messagePersisted"; message: unknown },
): void {
  const scope = { sessionKey: state.sessionKey };
  const projection = reduceSessionProjection(getChatSessionProjection(state, scope), {
    ...event,
    scope,
  });
  publishChatSessionProjection(state, projection);
  state.chatMessages = [...projection.messages];
}

function createActiveStreamingState() {
  return createState({ chatRunId: "run-user", chatStream: "Working...", chatStreamStartedAt: 123 });
}

describe("handleChatGatewayEvent", () => {
  it("drops sessionless run-idless terminal events instead of materializing them", () => {
    // Companion/internal runs can surface unkeyed terminal events; with no
    // active run, undefined === undefined must not pass the run-id fallback.
    const state = createState();
    const before = state.chatMessages.length;
    handleChatGatewayEvent(state, {
      state: "final",
      message: textMessage("assistant", "leaked companion answer"),
    } as ChatEventPayload);
    expect(state.chatMessages.length).toBe(before);
    expect(JSON.stringify(state.chatMessages)).not.toContain("leaked companion answer");
  });

  it("adopts startup status only for the queued local run before its ACK", () => {
    const state = createState({
      chatQueue: [
        {
          id: "queued-1",
          text: "hello",
          createdAt: 1,
          sendRunId: "run-1",
          sendState: "sending",
        },
      ],
    });

    receive(state, "status", { runId: "run-other", phase: "preparing_workspace" });
    expect(state.chatRunId).toBeNull();
    expect(state.chatRunStartup).toBeNull();

    receive(state, "status", { phase: "preparing_workspace" });
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatRunStartup).toEqual({
      state: "status",
      runId: "run-1",
      phase: "preparing_workspace",
    });
    receive(state, "final", { message: { role: "assistant", content: "Done" } });
    receive(state, "status", { phase: "preparing_workspace" });
    expect(state.chatRunId).toBeNull();
    expect(state.chatRunStartup).toBeNull();
  });

  it("shows startup status until the first chat delta and ignores late status", () => {
    const state = createState({ chatRunId: "run-1", chatStream: "" });
    const status: ChatEventPayload = chatEvent("status", { phase: "preparing_context" });

    handleChatGatewayEvent(state, status);
    expect(state.chatRunStartup).toEqual({
      state: "status",
      runId: "run-1",
      phase: "preparing_context",
    });

    receive(state, "delta", { runId: "run-other", deltaText: "Other reply" });
    expect(state.chatRunStartup).toEqual({
      state: "status",
      runId: "run-1",
      phase: "preparing_context",
    });

    receive(state, "delta", { deltaText: "Hello" });
    expect(state.chatRunStartup).toEqual({ state: "activity", runId: "run-1" });

    handleChatGatewayEvent(state, status);
    expect(state.chatRunStartup).toEqual({ state: "activity", runId: "run-1" });
  });

  it("appends one background final when three retained panes receive the same event", () => {
    const cache = new Map();
    const states = ["one", "two", "three"].map((sessionKey) =>
      createState({ chatMessagesBySession: cache, sessionKey }),
    );
    const payload: ChatEventPayload = chatEvent("final", {
      sessionKey: "background",
      message: textMessage("assistant", "background final"),
    });
    seedChatSnapshot(states[0]!, { sessionKey: "background" });

    for (const state of states) {
      handleChatGatewayEvent(state, payload);
    }

    expect(readChatMessagesFromCache(cache, states[0]!, { sessionKey: "background" })).toEqual([
      payload.message,
    ]);
  });

  it("appends configured default-session finals under runtime aliases", () => {
    const activeSessionKey = "agent:ops:other";
    const payloadSessionKey = "agent:ops:home";

    const state = createState({ sessionKey: activeSessionKey, chatMessagesBySession: new Map() });
    const payload: ChatEventPayload = chatEvent("final", {
      sessionKey: payloadSessionKey,
      message: textMessage("assistant", "cached final"),
    });

    (state as Record<string, unknown>).hello = {
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "ops",
          mainKey: "home",
        },
      },
    };
    seedChatSnapshot(state, { sessionKey: payloadSessionKey });

    handleChatGatewayEvent(state, payload);
    expect(
      readChatMessagesFromCache(state.chatMessagesBySession ?? new Map(), state, {
        sessionKey: payloadSessionKey,
      }),
    ).toEqual([payload.message]);
    expect(state.chatMessagesBySession?.size).toBe(1);
  });

  it("appends inactive global finals under the payload agent only", () => {
    const visibleMessage = textMessage("assistant", "work visible");
    const state = createState({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      chatMessages: [visibleMessage],
      chatMessagesBySession: new Map(),
    });
    const payload: ChatEventPayload = chatEvent("final", {
      runId: "run-main-global",
      sessionKey: "global",
      agentId: "main",
      message: textMessage("assistant", "main final"),
    });
    seedChatSnapshot(state, { sessionKey: "global", agentId: "main" });

    handleChatGatewayEvent(state, payload);
    expect(state.chatMessages).toEqual([visibleMessage]);
    expect(
      readChatMessagesFromCache(state.chatMessagesBySession ?? new Map(), state, {
        sessionKey: "global",
        agentId: "main",
      }),
    ).toEqual([payload.message]);
    expect(state.chatMessagesBySession?.has("agent:work:main")).toBe(false);
  });

  it("does not let a stale run id override session ownership", () => {
    const visibleMessage = textMessage("assistant", "selected session stays visible");
    const state = createState({
      chatRunId: "shared-run-id",
      chatMessages: [visibleMessage],
      chatMessagesBySession: new Map(),
      chatStream: "selected session stream",
    });
    const inactiveSessionKey = "agent:main:inactive-session";
    seedChatSnapshot(state, { sessionKey: inactiveSessionKey });

    receive(state, "delta", {
      runId: "shared-run-id",
      sessionKey: inactiveSessionKey,
      deltaText: "wrong-session stream",
    });
    const inactiveFinal = textMessage("assistant", "wrong-session final");
    receive(state, "final", {
      runId: "shared-run-id",
      sessionKey: inactiveSessionKey,
      message: inactiveFinal,
    });

    expect(state.chatMessages).toEqual([visibleMessage]);
    expect(state.chatStream).toBe("selected session stream");
    expect(state.chatRunId).toBe("shared-run-id");
    expect(
      readChatMessagesFromCache(state.chatMessagesBySession ?? new Map(), state, {
        sessionKey: inactiveSessionKey,
      }),
    ).toEqual([inactiveFinal]);
  });

  it("treats unscoped global events as default-agent events only", () => {
    const state = createState({
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
    });
    const payload: ChatEventPayload = chatEvent("final", {
      runId: "run-default-global",
      sessionKey: "global",
    });

    handleChatGatewayEvent(state, payload);
    expect(state.chatRunId).toBeNull();
  });

  it("adopts canonical global deltas for the selected agent main alias", () => {
    const state = createState({
      agentsList: { defaultId: "main", mainKey: "main", scope: "global" },
      sessionKey: "agent:work:main",
    });
    const payload: ChatEventPayload = chatEvent("delta", {
      runId: "run-work-global",
      sessionKey: "global",
      agentId: "work",
      message: textMessage("assistant", "Work reply"),
    });

    handleChatGatewayEvent(state, payload);
    expect(state.chatRunId).toBe("run-work-global");
    expect(state.chatStream).toBe("Work reply");
    expect(state.chatStreamStartedAt).toEqual(expect.any(Number));
  });

  it.each([
    {
      name: "renders the cumulative snapshot across a rolled-over stream boundary",
      previous: null,
      segments: [{ text: "Live", ts: 1, runId: "run-1", boundaryRunId: "steer-run" }],
      delta: " reply",
      snapshot: "Live reply",
      expected: "Live reply",
    },
    {
      name: "retracts the stream when a replacement snapshot is empty",
      previous: "Draft",
      delta: "",
      snapshot: "",
      replace: true,
      expected: "",
    },
  ])("$name", ({ previous, segments, delta, snapshot, replace, expected }) => {
    const state = createState({
      chatRunId: "run-1",
      chatStream: previous,
      ...(segments ? { chatStreamSegments: segments } : {}),
    });
    const payload: ChatEventPayload = chatEvent("delta", {
      deltaText: delta,
      message: textMessage("assistant", snapshot),
      ...(replace ? { replace: true } : {}),
    });

    handleChatGatewayEvent(state, payload);
    expect(state.chatStream).toBe(expected);
  });

  it("reuses persisted text across live deltas and refreshes replaced messages", () => {
    const persistedMessage = (id: string, text: string) => {
      const readContent = vi.fn(() => [{ type: "text", text }]);
      return {
        readContent,
        message: {
          role: "assistant",
          get content() {
            return readContent();
          },
          __openclaw: { id, runId: "run-1" },
        },
      };
    };
    const first = persistedMessage("part-a", "A");
    const second = persistedMessage("part-b", "B");
    const state = createState({
      chatRunId: "run-1",
      chatMessages: [first.message, second.message],
    });
    const receiveDelta = (text: string) => {
      receive(state, "delta", { message: textMessage("assistant", text) });
      return visibleCurrentAssistantStreamTail(state, () => false);
    };

    expect(receiveDelta("ABC")).toBe("C");
    expect(first.readContent).toHaveBeenCalled();
    expect(second.readContent).toHaveBeenCalled();
    first.readContent.mockClear();
    second.readContent.mockClear();

    for (const text of ["ABCD", "ABCDE", "ABCDEF"]) {
      expect(receiveDelta(text)).toBe(text.slice(2));
    }
    expect(first.readContent).not.toHaveBeenCalled();
    expect(second.readContent).not.toHaveBeenCalled();

    const replacement = persistedMessage("part-b", "BC");
    state.chatMessages = [first.message, replacement.message];
    expect(receiveDelta("ABCDEFG")).toBe("DEFG");
    expect(replacement.readContent).toHaveBeenCalled();
    expect(first.readContent).not.toHaveBeenCalled();
    expect(second.readContent).not.toHaveBeenCalled();
  });

  it("keeps a delivered legacy text-only assistant visible exactly once across stale history", async () => {
    const final = {
      text: "Delivered answer",
      timestamp: 42,
      __openclaw: { id: "legacy-final", seq: 2 },
    };

    const user = textMessage("user", "Ask", { id: "persisted-user", seq: 1 });
    const request = vi.fn().mockResolvedValue({ messages: [user] });
    const state = createHistoryState(request, {
      chatMessages: [user],
      chatRunId: "delivered-run",
    });

    receive(state, "final", { runId: "delivered-run", message: final });

    const normalizedFinal = {
      ...final,
      role: "assistant",
      content: [{ type: "text", text: final.text }],
    };
    expect(state.chatMessages).toEqual([user, normalizedFinal]);
    receive(state, "final", { runId: "delivered-run", message: final });
    expect(state.chatMessages).toEqual([user, normalizedFinal]);

    await loadChatHistory(state);
    expect(state.chatMessages).toEqual([user, normalizedFinal]);

    await loadChatHistory(state);
    expect(state.chatMessages).toEqual([user, normalizedFinal]);
  });

  it("settles an active run when its terminal reply was already accepted", () => {
    const runId = "run-1";
    const final = textMessage("assistant", "Delivered answer");
    const state = createStateWithRunningSession({
      sessionKey: "main",
      chatRunId: runId,
      chatStream: "Delivered answer",
      chatStreamStartedAt: 123,
      chatRunStartup: { state: "activity", runId },
    });
    state.chatStreamSegments = [{ text: "Retained commentary", ts: 122, toolCallId: "call-1" }];
    state.knownAgentRunIds = new Set([runId]);
    const scope = { sessionKey: state.sessionKey };
    const projection = reduceSessionProjection(getChatSessionProjection(state, scope), {
      type: "runTerminal",
      runId,
      status: "completed",
      message: final,
      scope,
    });
    publishChatSessionProjection(state, projection);
    publishChatSessionProjectionMessages(state, [final], { scope });

    receive(state, "final", { runId, message: final });

    expect(state.chatMessages).toEqual([final]);
    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamSegments).toEqual([]);
    expect(state.chatRunStartup).toBeNull();
    expect(state.knownAgentRunIds.has(runId)).toBe(false);
    expect(state.sessionsResult.sessions[0]).toMatchObject({
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
    });
    expect(state.lastLocalTerminalReconcile).toMatchObject({
      runId,
      sessionKey: "main",
      phase: "done",
      sessionStatus: "done",
    });
  });

  it("replaces an exact keyed final-answer stream with the persisted terminal", () => {
    const user = textMessage("user", "Ask", undefined, 1);
    const state = createState({ chatRunId: "run-1", chatMessages: [user] });
    state.chatStreamSegments = [{ text: "Final answer.", ts: 2, itemId: "final-answer-1" }];

    receive(state, "final", {
      message: textMessage("assistant", "Final answer.", undefined, 5),
    });

    expect(state.chatMessages).toHaveLength(2);
    expectTextMessage(state.chatMessages[0], "user", "Ask");
    expectTextMessage(state.chatMessages[1], "assistant", "Final answer.");
    expect(state.chatStreamSegments).toEqual([]);
  });

  it("preserves an already-recorded stream boundary for a persisted steer", () => {
    const state = createState({
      chatRunId: "run-1",
      chatMessages: [
        { role: "user", content: [{ type: "text", text: "Ask" }], timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Looking into it." }],
          timestamp: 2,
          openclawStreamFallback: {
            itemId: "preamble-1",
            replacementText: "Looking into it.",
            source: "segment",
          },
        },
        textMessage("user", "Focus on deployment", { idempotencyKey: "steer-send-1:user" }, 3),
      ],
    });
    state.chatStreamSegments = [
      {
        text: "Looking into it.",
        ts: 2,
        itemId: "preamble-1",
        boundaryRunId: "steer-send-1",
      },
    ];

    receive(state, "final", {
      message: textMessage("assistant", "Final answer.", undefined, 5),
    });

    expect(state.chatMessages).toHaveLength(4);
    expectTextMessage(state.chatMessages[0], "user", "Ask");
    expectTextMessage(state.chatMessages[1], "assistant", "Looking into it.");
    expectTextMessage(state.chatMessages[2], "user", "Focus on deployment");
    expectTextMessage(state.chatMessages[3], "assistant", "Final answer.");
  });

  it("keeps a terminal-only suffix after a steer with no post-boundary delta", () => {
    const state = createState({
      chatRunId: "run-1",
      chatMessages: [
        textMessage("user", "Ask", { idempotencyKey: "run-1:user" }, 1),
        textMessage("user", "Steer", { idempotencyKey: "steer-1:user" }, 3),
      ],
    });
    state.chatStreamSegments = [
      { text: "Before steer.", ts: 2, runId: "run-1", boundaryRunId: "steer-1" },
    ];

    receive(state, "final", {
      message: textMessage("assistant", "Before steer. Final unseen suffix.", undefined, 4),
    });

    expect(state.chatMessages).toHaveLength(4);
    expectTextMessage(state.chatMessages[0], "user", "Ask");
    expectTextMessage(state.chatMessages[1], "assistant", "Before steer.");
    expectTextMessage(state.chatMessages[2], "user", "Steer");
    expectTextMessage(state.chatMessages[3], "assistant", "Final unseen suffix.");
  });

  it("clears keyed commentary when chatPersistCommentary is false", () => {
    const user = textMessage("user", "Ask", undefined, 1);
    const state = createState({
      chatRunId: "run-1",
      chatMessages: [user],
      settings: { chatPersistCommentary: false },
    });
    state.chatStreamSegments = [{ text: "Looking into it.", ts: 2, itemId: "preamble-1" }];
    const payload: ChatEventPayload = chatEvent("final", {
      message: textMessage("assistant", "Final answer.", undefined, 5),
    });

    handleChatGatewayEvent(state, payload);
    expect(state.chatMessages).toHaveLength(2);
    expectTextMessage(state.chatMessages[0], "user", "Ask");
    expectTextMessage(state.chatMessages[1], "assistant", "Final answer.");
    expect(state.chatStreamSegments).toEqual([]);
  });

  it.each([
    {
      name: "provider timeout",
      event: {
        state: "error",
        errorKind: "timeout",
        errorMessage: "agent provider timeout",
      },
      projectionStatus: "timeout",
      sessionStatus: "timeout",
      errorSummary: "Error: agent provider timeout",
    },
    {
      name: "operator cancellation",
      event: { state: "aborted" },
      projectionStatus: "aborted",
      sessionStatus: "killed",
      errorSummary: null,
    },
  ] as const)(
    "projects the canonical $name status onto the selected session",
    ({ event, projectionStatus, sessionStatus, errorSummary }) => {
      const state = createStateWithRunningSession({
        chatRunId: "run-1",
        chatStream: "Partial assistant reply",
        chatStreamStartedAt: 100,
      });
      const staleSessionsResult = state.sessionsResult;

      handleChatGatewayEvent(state, {
        runId: "run-1",
        sessionKey: "main",
        ...event,
      });

      expect(getChatSessionProjection(state, { sessionKey: "main" }).runs["run-1"]?.status).toBe(
        projectionStatus,
      );
      expect(state.sessionsResult.sessions[0]).toMatchObject({
        activeRunIds: [],
        hasActiveRun: false,
        status: sessionStatus,
      });
      expect(state.sessionsResult.sessions[0]?.lastRunError ?? null).toBe(errorSummary);
      expect(state.lastLocalTerminalReconcile?.sessionStatus).toBe(sessionStatus);
      expect(state.chatRunStatus).toMatchObject({
        phase: "interrupted",
        runId: "run-1",
        sessionKey: "main",
      });
      expect(state.chatRunError?.summary ?? null).toBe(errorSummary);
      expect(state.chatRunId).toBeNull();
      expect(state.chatStream).toBeNull();
      expect(state.chatStreamStartedAt).toBeNull();

      state.sessionsResult = staleSessionsResult;
      expect(reconcileChatRunAfterSessionStatePublication(state)).toBe(true);
      expect(state.sessionsResult.sessions[0]).toMatchObject({
        hasActiveRun: false,
        status: sessionStatus,
      });
      expect(state.sessionsResult.sessions[0]?.lastRunError ?? null).toBe(errorSummary);
    },
  );

  it("reconciles cached run and indicator state on terminal events", () => {
    const state = createStateWithRunningSession({
      chatRunId: "run-1",
      chatStream: "Live reply",
      chatStreamStartedAt: 100,
    });
    state.compactionStatus = {
      phase: "active",
      runId: "run-1",
      startedAt: 100,
      completedAt: null,
    };
    state.compactionClearTimer = setTimeout(() => undefined, 1_000);
    state.fallbackStatus = {
      selected: "openai/gpt-5.5",
      active: "anthropic/claude-sonnet-4-6",
      attempts: [],
      occurredAt: 100,
    };
    state.fallbackClearTimer = setTimeout(() => undefined, 1_000);
    const payload: ChatEventPayload = chatEvent("final", {
      stopReason: "completed",
      yielded: true,
      message: textMessage("assistant", "Live reply"),
    });

    handleChatGatewayEvent(state, payload);

    expectSettled(state);
    expect(state.compactionStatus).toBeNull();
    expect(state.compactionClearTimer).toBeNull();
    expect(state.fallbackStatus).toBeNull();
    expect(state.fallbackClearTimer).toBeNull();
    expect(state.chatRunStatus).toMatchObject({
      phase: "done",
      runId: "run-1",
      sessionKey: "main",
    });
    expect(state.sessionsResult.sessions[0]).toMatchObject({
      hasActiveRun: false,
      status: "done",
    });
  });

  it("does not publish Done while a yielded turn has registered continuation work", () => {
    const state = createStateWithRunningSession({
      chatRunId: "run-1",
      chatStream: "Restarting now",
      chatStreamStartedAt: 100,
    });

    receive(state, "final", {
      stopReason: "end_turn",
      yielded: true,
      message: textMessage(
        "assistant",
        "The gateway will restart; I will resume verification afterward.",
      ),
    });

    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(state.chatRunStatus).toBeNull();
    expect(state.sessionsResult.sessions[0]).toMatchObject({
      hasActiveRun: false,
      activeRunIds: [],
      status: "running",
    });
  });

  it("ignores NO_REPLY delta updates", () => {
    const state = createState({ chatRunId: "run-1", chatStream: "Hello" });
    const payload: ChatEventPayload = chatEvent("delta", {
      message: textMessage("assistant", "NO_REPLY"),
    });

    handleChatGatewayEvent(state, payload);
    expect(state.chatStream).toBe("Hello");
  });

  it("appends final payload from another run without clearing active stream", () => {
    const state = createActiveStreamingState();
    const payload: ChatEventPayload = chatEvent("final", {
      runId: "run-announce",
      message: textMessage("assistant", "Sub-agent findings"),
    });
    handleChatGatewayEvent(state, payload);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]).toEqual(payload.message);
  });

  it("ignores HEARTBEAT_OK delta updates", () => {
    const state = createState({ chatRunId: "run-1", chatStream: "Previous visible text" });
    const payload: ChatEventPayload = chatEvent("delta", {
      message: textMessage("assistant", "HEARTBEAT_OK"),
    });

    handleChatGatewayEvent(state, payload);
    expect(state.chatStream).toBe("Previous visible text");
  });

  it("keeps active stream for unowned final payloads", () => {
    const state = createActiveStreamingState();
    const payload: ChatEventPayload = chatEvent("final", { runId: undefined });

    handleChatGatewayEvent(state, payload);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toStrictEqual([]);
  });

  it("persists streamed text when final event carries no message", () => {
    const existingMessage = textMessage("user", "Hi", undefined, 1);
    const state = createState({
      chatRunId: "run-1",
      chatStream: "Here is my reply",
      chatStreamStartedAt: 100,
      chatMessages: [existingMessage],
    });
    const payload: ChatEventPayload = chatEvent("final");

    handleChatGatewayEvent(state, payload);
    expectSettled(state);
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(existingMessage);
    expectTextMessage(state.chatMessages[1], "assistant", "Here is my reply");
  });

  it("keeps repeated assistant final text within the same turn", () => {
    const user = textMessage("user", "repeat", undefined, 1);
    const firstAssistant = textMessage("assistant", "OK", undefined, 2);
    const secondAssistant = {
      role: "assistant",
      content: [
        { type: "text", text: "OK" },
        { type: "canvas", url: "/__openclaw__/canvas/documents/repeat/index.html" },
      ],
      timestamp: 3,
    };
    const state = createState({ chatRunId: "run-1", chatMessages: [user, firstAssistant] });
    const payload: ChatEventPayload = chatEvent("final", { message: secondAssistant });

    handleChatGatewayEvent(state, payload);
    expect(state.chatMessages).toEqual([user, firstAssistant, secondAssistant]);
  });

  it.each([
    ["assistant", textMessage("assistant", "Partial reply", undefined, 2), true],
    ["user", textMessage("user", "unexpected"), false],
  ] as const)(
    "keeps one partial reply for an aborted %s payload",
    (_role, message, preservePayload) => {
      const stream = "Partial reply";
      const existing = textMessage("user", "Hi", undefined, 1);
      const state = createState({
        chatRunId: "run-1",
        chatStream: stream,
        chatStreamStartedAt: 100,
        chatMessages: [existing],
      });
      const payload = chatEvent("aborted", { message });

      handleChatGatewayEvent(state, payload);
      expectSettled(state);
      expect(state.chatMessages[0]).toEqual(existing);
      expect(state.chatMessages).toHaveLength(2);
      expectTextMessage(state.chatMessages[1], "assistant", stream);
      if (preservePayload) {
        expect(state.chatMessages[1]).toEqual(message);
      }
    },
  );
  type TerminalErrorFixture = {
    stream?: string | null;
    previous?: ReturnType<typeof textMessage>[];
    segments?: Array<{ text: string; ts: number; toolCallId?: string }>;
    message?: Record<string, unknown>;
    expected: Array<readonly ["assistant" | "user", string]>;
    verify?: (state: ChatState) => void;
  };

  it.each([
    {
      name: "keeps streamed text without appending the error payload message",
      create(): TerminalErrorFixture {
        return {
          stream: "Partial answer before gateway error.",
          message: {
            ...textMessage("assistant", "Error: gateway disconnected", undefined, 101),
            metadata: { source: "gateway" },
          },
          expected: [["assistant", "Partial answer before gateway error."]],
        };
      },
    },
    {
      name: "preserves terminal extensions after a tool splits the stream",
      create(): TerminalErrorFixture {
        const text = "First thought. After tool. Final detail.";
        return {
          stream: "After tool.",
          segments: [{ text: "First thought.", ts: 90, toolCallId: "call-1" }],
          message: textMessage("assistant", text, undefined, 101),
          expected: [["assistant", text]],
        };
      },
    },
    {
      name: "preserves a split stream when the terminal message only overlaps its prefix",
      create(): TerminalErrorFixture {
        const terminal = textMessage(
          "assistant",
          "First thought. Configure provider auth.",
          undefined,
          101,
        );
        return {
          stream: "After tool.",
          segments: [{ text: "First thought.", ts: 90, toolCallId: "call-1" }],
          message: terminal,
          expected: [
            ["assistant", "First thought."],
            ["assistant", "After tool."],
            ["assistant", "First thought. Configure provider auth."],
          ],
          verify: (state) => expect(state.chatMessages[2]).toEqual(terminal),
        };
      },
    },
    {
      name: "keeps stream segments visible when an error ends after a tool event",
      create(): TerminalErrorFixture {
        const partial = "Visible text before tool.";
        return {
          previous: [textMessage("user", "Ping", undefined, 1)],
          stream: null,
          segments: [{ text: partial, ts: 100, toolCallId: "call-before-error" }],
          expected: [
            ["user", "Ping"],
            ["assistant", partial],
          ],
          verify: (state) => {
            const streamState = state as ChatState & {
              chatStreamSegments: NonNullable<TerminalErrorFixture["segments"]>;
            };
            expect(streamState.chatStreamSegments).toEqual([]);
            const rendered = buildChatItems({
              paneId: "terminal-error-stream-owner",
              sessionKey: state.sessionKey,
              runId: state.chatRunId,
              messages: state.chatMessages,
              toolMessages: [],
              streamSegments: streamState.chatStreamSegments,
              stream: state.chatStream,
              streamStartedAt: state.chatStreamStartedAt,
              showToolCalls: true,
            }).flatMap((item) =>
              item.kind === "group"
                ? item.messages.map(({ message }) => extractText(message))
                : item.kind === "stream"
                  ? [item.text.trim()]
                  : [],
            );
            expect(rendered.filter((text) => text === partial)).toHaveLength(1);
          },
        };
      },
    },
  ])("$name", (fixture) => {
    const { stream, previous, segments, message, expected, verify } = fixture.create();
    const error = "gateway disconnected";
    const state = createState({
      chatRunId: "run-1",
      ...(previous ? { chatMessages: previous } : {}),
      ...(stream === undefined
        ? {}
        : { chatStream: stream, chatStreamStartedAt: stream ? 100 : null }),
    });
    if (segments) {
      state.chatStreamSegments = segments;
    }
    const payload: ChatEventPayload = chatEvent("error", {
      errorMessage: error,
      ...(message ? { message } : {}),
    });

    handleChatGatewayEvent(state, payload);
    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
    expect(state.chatMessages).toHaveLength(expected.length);
    for (const [index, [role, text]] of expected.entries()) {
      expectTextMessage(state.chatMessages[index], role, text);
    }
    expect(state.chatRunError).toEqual({ summary: `Error: ${error}`, runId: "run-1" });
    verify?.(state);
  });

  it("adds bounded OAuth facts to live errors without changing the summary", () => {
    const summary =
      "⚠️ Your refresh token has already been used to generate a new access token. Please try signing in again.";
    const state = createState({ chatRunId: "run-1" });

    receive(state, "error", {
      errorMessage: summary,
      errorDetail: {
        provider: "openai",
        failoverReason: "refresh_token_reused",
        providerRuntimeFailureKind: "auth_refresh",
        providerErrorType: "invalid_request_error",
        httpStatus: 401,
      },
    });
    expect(state.chatRunError).toEqual({
      kind: "auth_refresh",
      runId: "run-1",
      summary: `${summary}\n\nProvider: openai\nHTTP status: 401\nReason: refresh_token_reused\nType: invalid_request_error`,
    });
  });

  it.each([
    {
      name: "canonical persisted assistant identities",
      sourceMetadata: { id: "message-tool-source-reply", seq: 7 },
      finalMetadata: { id: "automatic-final-reply", seq: 8 },
    },
    {
      name: "legacy assistant replies without transcript metadata",
      sourceMetadata: undefined,
      finalMetadata: undefined,
    },
  ])(
    "deduplicates the second distinct same-run final with $name",
    ({ sourceMetadata, finalMetadata }) => {
      const state = createState({ sessionKey: "main", chatRunId: "run-message-tool" });
      const sourceReply = textMessage(
        "assistant",
        "Visible progress from the targetless message tool.",
        sourceMetadata,
      );
      const automaticReply = textMessage(
        "assistant",
        "Visible automatic final reply.",
        finalMetadata,
      );
      const sourceEvent = {
        runId: "run-message-tool",
        sessionKey: "main",
        state: "final" as const,
        message: sourceReply,
      };
      const finalEvent = {
        runId: "run-message-tool",
        sessionKey: "main",
        state: "final" as const,
        message: automaticReply,
      };

      expect(handleChatGatewayEvent(state, sourceEvent)).toBe("final");
      expect(handleChatGatewayEvent(state, finalEvent)).toBe("final");
      expect(handleChatGatewayEvent(state, finalEvent)).toBe("final");

      expect(state.chatMessages).toEqual([sourceReply, automaticReply]);
      expect(state.chatRunId).toBeNull();
      expect(state.chatStream).toBeNull();
    },
  );

  it("does not label a newer response with a completed run's late error", () => {
    const state = createState({ chatRunId: "run-completed" });

    receive(state, "final", {
      runId: "run-completed",
      message: textMessage("assistant", "Delivered once."),
    });
    receive(state, "delta", {
      runId: "run-newer",
      message: textMessage("assistant", "Newer response"),
    });
    receive(state, "error", { runId: "run-completed", errorMessage: "late provider failure" });

    expect(state.chatRunId).toBe("run-newer");
    expect(state.chatStream).toBe("Newer response");
    expect(state.chatMessages).toHaveLength(1);
    expectTextMessage(state.chatMessages[0], "assistant", "Delivered once.");
    expect(state.chatRunError).toBeNull();
  });

  it("upgrades an empty final to one authoritative assistant reply", () => {
    const state = createState({ chatRunId: "run-empty-final" });

    receive(state, "final", { runId: "run-empty-final" });
    const deliveredFinal = chatEvent("final", {
      runId: "run-empty-final",
      message: textMessage("assistant", "Delayed authoritative reply."),
    });
    handleChatGatewayEvent(state, deliveredFinal);
    handleChatGatewayEvent(state, deliveredFinal);

    expect(state.chatMessages).toHaveLength(1);
    expectTextMessage(state.chatMessages[0], "assistant", "Delayed authoritative reply.");
    expect(state.chatRunId).toBeNull();
  });

  it.each(["delta", "final"] as const)(
    "replaces retry progress and clears it on %s",
    (terminalState) => {
      const state = createState({ chatRunId: "run-retry" });
      const envelope = { sessionKey: "main", runId: "run-retry" };
      receive(state, "delta", { ...envelope, deltaText: "" });
      for (const attempt of [2, 3]) {
        receive(state, "status", {
          ...envelope,
          seq: attempt,
          retry: { attempt, maxAttempts: 10, reason: "rate_limit" },
        });
        expect(chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null)).toBe(
          `Retrying… ${attempt}/10`,
        );
        expect(state.chatMessages).toEqual([]);
        expect(state.chatRunError).toBeFalsy();
      }
      handleChatGatewayEvent(state, { ...envelope, state: terminalState });
      expect(activeChatRunStartupStatus(state.chatRunStartup)).toBeNull();
    },
  );

  it.each([
    { name: "empty content", content: [] },
    {
      name: "normalized assistant role",
      role: " Assistant ",
      content: [{ type: "text", text: "⚠️ Error: provider rate limit" }],
    },
  ])(
    "keeps resumed deltas in one reply after repeated $name errors",
    ({ content, role = "assistant" }) => {
      const state = createState({ chatRunId: "run-retry" });
      const envelope = { sessionKey: "main", runId: "run-retry" };
      for (let attempt = 0; attempt < 4; attempt++) {
        receive(state, "error", {
          ...envelope,
          seq: attempt + 1,
          errorMessage: "provider rate limit",
          message: { role, content, stopReason: "error" },
        });
      }
      const terminalMessages = [...state.chatMessages];
      receive(state, "delta", { ...envelope, seq: 3, deltaText: "stale output" });
      expect(state.chatRunId).toBeNull();
      expect(state.chatStream).toBeNull();
      expect(state.chatMessages).toEqual(terminalMessages);
      expect(state.chatRunError).not.toBeNull();
      let seq = 5;
      for (const text of ["I", "I agree", "I agree with that product direction."]) {
        receive(state, "delta", {
          ...envelope,
          seq: seq++,
          message: textMessage("assistant", text),
        });
        expect(state.chatStream).toBe(text);
        expect(state.chatRunId).toBe(envelope.runId);
        expect(state.chatMessages).toEqual([]);
        expect(state.chatRunError).toBeNull();
      }
      receive(state, "final", {
        ...envelope,
        seq,
        message: textMessage("assistant", "I agree with that product direction."),
      });
      expect(state.chatMessages).toHaveLength(1);
      expectTextMessage(state.chatMessages[0], "assistant", "I agree with that product direction.");
      expect(state.chatStreamSegments ?? []).toEqual([]);
      expect(state.chatRunId).toBeNull();
    },
  );

  it("retires the same-run history error projection when streaming resumes: [assistant turn failed before producing content]", () => {
    const text = "[assistant turn failed before producing content]";

    const useful = {
      ...textMessage("assistant", "Useful earlier commentary."),
      __openclaw: { runId: "run-retry" },
    };
    const placeholder = {
      role: "assistant",
      stopReason: "error",
      __openclaw: { runId: "run-retry" },
      content: [{ type: "text", text }],
    };
    const state = createState({ chatRunId: "run-retry", chatMessages: [useful, placeholder] });
    receive(state, "error", {
      runId: "run-retry",
      seq: 1,
      errorMessage: "provider rate limit",
      message: placeholder,
    });
    receive(state, "delta", {
      runId: "run-retry",
      seq: 2,
      message: textMessage("assistant", "Recovered reply."),
    });
    expect(state.chatStream).toBe("Recovered reply.");
    expect(state.chatMessages).toEqual([useful]);
  });

  it("uses the generic alert fallback for a blank orphan error", () => {
    const state = createState();

    receive(state, "error", { runId: "run-failed-before-start", errorMessage: "   " });
    expect(state.chatMessages).toEqual([]);
    expect(state.lastError).toBeNull();
    expect(state.chatRunError).toEqual({ summary: "chat error", runId: "run-failed-before-start" });
  });

  it("drops NO_REPLY final payload from own run", () => {
    const state = createState({
      chatRunId: "run-1",
      chatStream: "NO_REPLY",
      chatStreamStartedAt: 100,
    });
    const payload: ChatEventPayload = chatEvent("final", {
      message: textMessage("assistant", "NO_REPLY"),
    });

    handleChatGatewayEvent(state, payload);
    expect(state.chatMessages).toStrictEqual([]);
    expect(state.chatRunId).toBe(null);
    expect(state.chatStream).toBe(null);
  });
});

describe("authoritative terminal history identity", () => {
  it("does not retire a native terminal for user or imported identities with a colliding id", () => {
    const collisions = [
      textMessage("user", "Different native user", { id: "native-terminal" }),
      textMessage("assistant", "Different imported assistant", {
        id: "native-terminal",
        importedFrom: "claude-cli",
        cliSessionId: "external-session",
        externalId: "external-terminal",
      }),
    ];
    const host = {};
    const nativeTerminal = textMessage("assistant", "Native terminal", {
      id: "native-terminal",
    });
    const liveTerminal = rememberLiveTerminalRun(
      textMessage("assistant", "Native terminal"),
      "run-1",
    );
    rememberAuthoritativeTerminal({
      event: { key: "main", runId: "run-1", hasActiveRun: false },
      host,
      matchesChat: true,
      payload: {
        message: nativeTerminal,
        messageId: "conflicting-envelope-id",
      },
      runIdBeforeApply: "run-1",
    });

    const previousMessages = [liveTerminal];
    const collided = reconcileAuthoritativeTerminalHistory({
      host,
      previousMessages,
      sessionKey: "main",
      visibleMessages: collisions,
    });
    expect(collided).toEqual(previousMessages);
    expect(authoritativeHistoryAppliedForRun(host, "run-1")).toBe(false);

    const persisted = reconcileAuthoritativeTerminalHistory({
      host,
      previousMessages,
      sessionKey: "main",
      visibleMessages: [...collisions, nativeTerminal],
    });
    expect(persisted).toEqual([]);
    expect(authoritativeHistoryAppliedForRun(host, "run-1")).toBe(true);
  });
});

describe("loadChatHistory filtering", () => {
  it("filters silent and synthetic history rows while preserving user content and media", async () => {
    const repair =
      "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
    const visible = [
      textMessage("user", "NO_REPLY"),
      textMessage("user", repair),
      textMessage("assistant", "no_reply"),
      textMessage("assistant", "ANNOUNCE_SKIP"),
      textMessage("assistant", "REPLY_SKIP"),
      textMessage("assistant", "Real answer"),
      { role: "assistant", text: "real reply", content: "NO_REPLY" },
      { role: "user", content: "", __openclaw: { media: [{ path: "/tmp/user.png" }] } },
      {
        role: "toolResult",
        toolCallId: "real",
        toolName: "shell",
        content: [{ type: "text", text: "real tool output" }],
      },
    ];
    const hidden = [
      textMessage("assistant", "NO_REPLY"),
      { role: "assistant", text: "  NO_REPLY  " },
      textMessage("assistant", "HEARTBEAT_OK"),
      textMessage(
        "user",
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsubagent completion payload\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
      ),
      { role: "user", content: "" },
      {
        role: "toolResult",
        toolCallId: "synthetic",
        toolName: "unknown",
        isError: true,
        content: [{ type: "text", text: repair }],
      },
    ];
    const { state } = createResolvedHistoryState({
      messages: [...hidden, ...visible],
      thinkingLevel: "low",
      verboseLevel: "full",
    });
    await loadChatHistory(state);
    expect(state.chatMessages).toEqual(visible);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatVerboseLevel).toBe("full");
    expect(state.chatLoading).toBe(false);
  });

  it("applies current session metadata from chat history", async () => {
    const { state } = createResolvedHistoryState({
      messages: [],
      sessionId: "legacy-session",
      thinkingLevel: "low",
      verboseLevel: "full",
      sessionInfo: {
        activeLeafEntryId: "leaf-rendered",
        key: "main",
        sessionId: "session-main",
        effectiveQueueMode: "interrupt",
        queueMode: "interrupt",
        thinkingLevel: "medium",
        modelProvider: "openai",
        model: "gpt-5",
        updatedAt: 123,
      },
    });

    const result = await loadChatHistory(state);

    expect(result?.sessionInfo?.sessionId).toBe("session-main");
    expect(state.currentSessionId).toBe("session-main");
    expect(state.chatDisplayedLeafEntryId).toBe("leaf-rendered");
    expect(state.chatThinkingLevel).toBe("medium");
    expect(state.chatVerboseLevel).toBe("full");
    expect(state.chatQueueModeOverride).toBe("interrupt");
    expect(state.chatEffectiveQueueMode).toBe("interrupt");
  });

  it("omits literal global agentId until selected/default agent is known", async () => {
    const { request, state } = createResolvedHistoryState(
      { messages: [] },
      {
        sessionKey: "global",
      },
    );

    await loadChatHistory(state);

    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.not.objectContaining({ agentId: expect.anything() }),
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
  });

  it("uses hello default agent for literal global history before agents list loads", async () => {
    const { request, state } = createResolvedHistoryState(
      { messages: [] },
      {
        sessionKey: "global",
        hello: {
          type: "hello-ok",
          protocol: 4,
          auth: { role: "operator", scopes: [] },
          snapshot: { sessionDefaults: { defaultAgentId: "ops" } },
        },
      },
    );

    await loadChatHistory(state);

    expect(request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ sessionKey: "global", agentId: "ops" }),
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
  });

  it("caches global history under the selected agent only", async () => {
    const messages = [textMessage("assistant", "work history")];
    const { state } = createResolvedHistoryState(
      { messages },
      {
        sessionKey: "global",
        assistantAgentId: "work",
        agentsList: { defaultId: "main" },
        chatMessagesBySession: new Map(),
      },
    );

    await loadChatHistory(state);

    expect(
      readChatMessagesFromCache(state.chatMessagesBySession ?? new Map(), state, {
        sessionKey: "global",
        agentId: "work",
      }),
    ).toEqual(messages);
    expect(state.chatMessagesBySession?.has("agent:main:main")).toBe(false);
  });

  it("coalesces overlapping pane startup loads when rendered message arrays change", async () => {
    const startup = createDeferred<HistoryResult>();
    const request = vi.fn(() => startup.promise);
    const client = createTestClient(request);
    const firstState = createHistoryStateForClient(client, { sessionKey: "agent:main:main" });
    const secondState = createHistoryStateForClient(client, {
      sessionKey: "agent:main:main",
      sessions: firstState.sessions,
    });

    const loads = [
      loadChatHistory(firstState, { startup: true }),
      loadChatHistory(secondState, { startup: true }),
    ];
    firstState.chatMessages = [...firstState.chatMessages];
    loads.push(loadChatHistory(firstState, { startup: true }));
    secondState.chatMessages = [...secondState.chatMessages];
    loads.push(loadChatHistory(secondState, { startup: true }));
    expect(request).toHaveBeenCalledOnce();
    startup.resolve(createAssistantHistory("shared"));
    await Promise.all(loads);

    expect(firstState.chatMessages).toEqual([textMessage("assistant", "shared")]);
    expect(secondState.chatMessages).toEqual(firstState.chatMessages);
  });
  it("keeps startup requests separate for different pane sessions", async () => {
    const request = vi.fn().mockResolvedValue({ messages: [] });
    const client = createTestClient(request);
    const firstState = createHistoryStateForClient(client, { sessionKey: "agent:main:first" });
    const secondState = createHistoryStateForClient(client, {
      sessionKey: "agent:main:second",
      sessions: firstState.sessions,
    });

    await Promise.all([
      loadChatHistory(firstState, { startup: true }),
      loadChatHistory(secondState, { startup: true }),
    ]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      "chat.startup",
      {
        sessionKey: "agent:main:first",
        limit: 80,
        maxBytes: 256 * 1024,
      },
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "chat.startup",
      {
        sessionKey: "agent:main:second",
        limit: 80,
        maxBytes: 256 * 1024,
      },
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
  });

  it("keeps startup requests separate across pane connection epochs", async () => {
    const staleStartup = createDeferred<HistoryResult>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => staleStartup.promise)
      .mockResolvedValueOnce(createAssistantHistory("fresh"));
    const client = createTestClient(request);
    const staleState = createHistoryStateForClient(client, {
      connectionEpoch: 1,
      sessionKey: "agent:main:main",
    });
    const freshState = createHistoryStateForClient(client, {
      connectionEpoch: 2,
      sessionKey: "agent:main:main",
      sessions: staleState.sessions,
    });

    const staleLoad = loadChatHistory(staleState, { startup: true });
    const freshLoad = loadChatHistory(freshState, { startup: true });

    expect(request).toHaveBeenCalledTimes(2);
    await freshLoad;
    staleStartup.resolve(createAssistantHistory("stale"));
    await staleLoad;

    expect(freshState.chatMessages).toEqual([
      { role: "assistant", content: [{ type: "text", text: "fresh" }] },
    ]);
  });
});

describe("loadChatHistory retry handling", () => {
  it("surfaces unknown chat.startup failures without requesting chat.history", async () => {
    const request = vi.fn().mockRejectedValue(
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: chat.startup",
      }),
    );
    const state = createHistoryState(request);

    await loadChatHistory(state, { startup: true });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "chat.startup",
      {
        sessionKey: "main",
        limit: 80,
        maxBytes: 256 * 1024,
      },
      { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(getChatHistoryLoadState(state)).toMatchObject({
      phase: "failed",
      message: expect.stringContaining("unknown method: chat.startup"),
      retryable: false,
    });
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
  });

  it("ends a stalled history load and cancels its request before Retry", async () => {
    const stalled = createDeferred<HistoryResult>();
    let signal: AbortSignal | undefined;
    const request = vi
      .fn()
      .mockImplementationOnce(
        (_method: string, _params: unknown, options?: { signal?: AbortSignal }) => {
          signal = options?.signal;
          return stalled.promise;
        },
      )
      .mockResolvedValueOnce(createAssistantHistory("recovered"));
    const state = createHistoryState(request);
    const loading = loadChatHistory(state);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(state.chatLoading).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await loading;

    expect(state.chatLoading).toBe(false);
    expect(getChatHistoryLoadState(state)).toMatchObject({
      phase: "failed",
      message: expect.stringContaining("timed out"),
    });
    expect(signal?.aborted).toBe(true);
    await loadChatHistory(state);
    expect(request).toHaveBeenCalledTimes(2);
    expect(state.chatMessages).toEqual(createAssistantHistory("recovered").messages);

    stalled.resolve(createAssistantHistory("expired"));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.chatMessages).toEqual(createAssistantHistory("recovered").messages);
  });

  it("expires each shared startup reader without consuming a late joiner's retry window", async () => {
    const unavailable = (retryAfterMs: number) =>
      new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "chat.history unavailable during gateway startup",
        details: { method: "chat.history" },
        retryable: true,
        retryAfterMs,
      });
    const retryableError = unavailable(250);
    const secondAttempt = createDeferred<unknown>();
    const request = vi
      .fn()
      .mockRejectedValueOnce(unavailable(59_000))
      .mockImplementationOnce(() => secondAttempt.promise)
      .mockResolvedValueOnce(createAssistantHistory("awake"));
    const client = createTestClient(request);
    const firstState = createHistoryStateForClient(client);
    const secondState = createHistoryStateForClient(client, { sessions: firstState.sessions });

    const firstLoad = loadChatHistory(firstState);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(59_000);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    const secondLoad = loadChatHistory(secondState);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_001);
    await firstLoad;
    expect(firstState.chatLoading).toBe(false);
    expect(getChatHistoryLoadState(firstState)).toMatchObject({
      phase: "failed",
      message: expect.stringContaining("timed out"),
    });
    expect(secondState.chatLoading).toBe(true);
    expect(request.mock.calls[1]?.[2]?.signal.aborted).toBe(false);
    secondAttempt.reject(retryableError);
    await vi.advanceTimersByTimeAsync(250);
    await secondLoad;

    expect(request).toHaveBeenCalledTimes(3);
    expect(secondState.chatMessages).toEqual([textMessage("assistant", "awake")]);
    expect(firstState.chatMessages).toEqual([]);
  });

  type RecoveredToolFixture = {
    tools: Record<string, unknown>[];
    persistedCount: number;
    segments: HistoryToolSegment[];
    stream: string;
    expectedRows: Array<number | { text: string; timestamp: number }>;
    expectedStream: string;
    remainingTools?: number[];
    remainingSegments?: HistoryToolSegment[];
  };

  const historyTool = (id: string, text: string, timestamp: number, seq: number) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "shell",
    content: [{ type: "text", text }],
    timestamp,
    __openclaw: { seq },
  });

  it.each([
    {
      name: "inserts multiple recovered stream segments before their matching persisted tools",
      create(): RecoveredToolFixture {
        return {
          tools: [
            historyTool("call_1", "first output", 2, 2),
            historyTool("call_2", "second output", 4, 3),
          ],
          persistedCount: 2,
          segments: [
            { text: "before first tool", ts: 1 },
            { text: "before first tool\nbefore second tool", ts: 3 },
          ],
          stream: "Still answering.",
          expectedRows: [
            { text: "before first tool", timestamp: 1 },
            0,
            { text: "before second tool", timestamp: 3 },
            1,
          ],
          expectedStream: "Still answering.",
        };
      },
    },
    {
      name: "prunes only the live tool cards that history has caught up with",
      create(): RecoveredToolFixture {
        return {
          tools: [
            historyTool("call_1", "first output", 2, 2),
            {
              role: "assistant",
              toolCallId: "call_2",
              runId: "run-1",
              content: [
                { type: "toolcall", name: "shell", arguments: {} },
                { type: "toolresult", name: "shell", text: "second output" },
              ],
              timestamp: 4,
            },
          ],
          persistedCount: 1,
          segments: [
            { text: "before first tool", ts: 1, toolCallId: "call_1" },
            { text: "before first tool\nbefore second tool", ts: 3, toolCallId: "call_2" },
          ],
          stream: "before first tool\nbefore second tool\nStill answering.",
          expectedRows: [{ text: "before first tool", timestamp: 1 }, 0],
          expectedStream: "Still answering.",
          remainingTools: [1],
          remainingSegments: [{ text: "before second tool", ts: 3, toolCallId: "call_2" }],
        };
      },
    },
    {
      name: "uses segment tool ids when a tool starts before any stream text",
      create(): RecoveredToolFixture {
        return {
          tools: [
            historyTool("call_1", "first output", 2, 2),
            historyTool("call_2", "second output", 4, 3),
          ],
          persistedCount: 2,
          segments: [{ text: "before second tool", ts: 3, toolCallId: "call_2" }],
          stream: "Still answering.",
          expectedRows: [0, { text: "before second tool", timestamp: 3 }, 1],
          expectedStream: "Still answering.",
        };
      },
    },
  ])("$name", async (fixture) => {
    const {
      tools,
      persistedCount,
      segments,
      stream,
      expectedRows,
      expectedStream,
      remainingTools = [],
      remainingSegments = [],
    } = fixture.create();
    const persistedUser = textMessage("user", "latest ask", { seq: 1 });
    const state = createLiveToolHistoryState(
      [persistedUser, ...tools.slice(0, persistedCount)],
      {
        chatMessages: [persistedUser],
        chatRunId: "run-1",
        chatStream: stream,
        chatStreamStartedAt: 100,
      },
      tools,
      segments,
    );

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(expectedRows.length + 1);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    for (const [index, row] of expectedRows.entries()) {
      if (typeof row === "number") {
        expect(state.chatMessages[index + 1]).toEqual(tools[row]);
      } else {
        expectTextMessage(state.chatMessages[index + 1], "assistant", row.text);
        expect(requireRecord(state.chatMessages[index + 1]).timestamp).toBe(row.timestamp);
      }
    }
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatStream).toBe(stream);
    expect(visibleCurrentAssistantStreamTail(state, () => false)).toBe(expectedStream);
    expect(state.chatStreamStartedAt).toBe(100);
    expect(state.chatToolMessages).toEqual(remainingTools.map((index) => tools[index]));
    expect(
      visibleParts(state).map(({ text, timestamp, toolCallId }) => ({
        text,
        ts: timestamp,
        toolCallId,
      })),
    ).toEqual(remainingSegments);
    expect(state.toolStreamById.size).toBe(remainingTools.length);
    expect(state.toolStreamOrder).toEqual(
      remainingTools.map((index) =>
        buildToolStreamIdentity("run-1", String(tools[index]?.toolCallId)),
      ),
    );
    for (const index of remainingTools) {
      expect(
        state.toolStreamById.has(
          buildToolStreamIdentity("run-1", String(tools[index]?.toolCallId)),
        ),
      ).toBe(true);
    }
  });

  it("clears live tool cards when history catches up with content-block tool ids", async () => {
    const persistedUser = textMessage("user", "latest ask", { seq: 1 });
    const persistedToolCall = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "shell",
          arguments: {},
        },
      ],
      timestamp: 2,
      __openclaw: { seq: 2 },
    };
    const state = createLiveToolHistoryState(
      [persistedUser, persistedToolCall],
      {
        chatMessages: [persistedUser],
        chatRunId: "run-1",
        chatStream: "Still answering.",
        chatStreamStartedAt: 100,
      },
      [
        {
          role: "assistant",
          toolCallId: "call_1",
          runId: "run-1",
          content: [{ type: "toolcall", name: "shell", arguments: {} }],
        },
      ],
      [{ text: "before tool", ts: 1 }],
    );

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(3);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextMessage(state.chatMessages[1], "assistant", "before tool");
    expect(requireRecord(state.chatMessages[1]).timestamp).toBe(1);
    expect(state.chatMessages[2]).toEqual(persistedToolCall);
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatStream).toBe("Still answering.");
    expect(state.chatStreamStartedAt).toBe(100);
    expect(state.chatToolMessages).toEqual([]);
    expect(visibleParts(state)).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("keeps segment-only streamed text when history catches up with tools", async () => {
    const persistedUser = textMessage("user", "latest ask", { seq: 1 });
    const persistedToolResult = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "shell",
      content: [{ type: "text", text: "tool output" }],
      timestamp: 2,
      __openclaw: { seq: 2 },
    };
    const state = createLiveToolHistoryState(
      [persistedUser, persistedToolResult],
      {
        chatMessages: [persistedUser],
        chatRunId: "run-1",
        chatStream: null,
        chatStreamStartedAt: 100,
      },
      [persistedToolResult],
      [{ text: "before tool", ts: 1 }],
    );

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(3);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextMessage(state.chatMessages[1], "assistant", "before tool");
    expect(requireRecord(state.chatMessages[1]).timestamp).toBe(1);
    expect(state.chatMessages[2]).toEqual(persistedToolResult);
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
    expect(state.chatToolMessages).toEqual([]);
    expect(visibleParts(state)).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("timestamps materialized streamed text after the persisted user prompt", async () => {
    const userTimestamp = 200;

    const persistedUser = textMessage("user", "first", { seq: 1 }, userTimestamp);
    const { state } = createHistorySnapshot([persistedUser], {
      chatMessages: [persistedUser],
      chatRunId: null,
      chatStream: "Partial answer before history catch-up.",
      chatStreamStartedAt: 100,
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextMessage(
      state.chatMessages[1],
      "assistant",
      "Partial answer before history catch-up.",
    );
    expect(requireRecord(state.chatMessages[1]).timestamp).toBe(201);
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
  });

  it("materializes orphaned segment-only assistant text before clearing caught-up tools", async () => {
    const persistedUser = textMessage("user", "latest ask", { seq: 1 });
    const persistedToolResult = {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "shell",
      content: [{ type: "text", text: "tool output" }],
      __openclaw: { seq: 2 },
    };
    const state = createLiveToolHistoryState(
      [persistedUser, persistedToolResult],
      {
        chatMessages: [persistedUser],
        chatRunId: null,
        chatStream: null,
        chatStreamStartedAt: null,
      },
      [persistedToolResult],
      [{ text: "before tool", ts: 1 }],
    );

    await loadChatHistory(state);

    expect(state.chatMessages).toHaveLength(3);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextMessage(state.chatMessages[1], "assistant", "before tool");
    expect(state.chatMessages[2]).toEqual(persistedToolResult);
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
    expect(state.chatToolMessages).toEqual([]);
    expect(state.chatStreamSegments).toEqual([]);
    expect(state.toolStreamById.size).toBe(0);
    expect(state.toolStreamOrder).toEqual([]);
  });

  it("keeps live tool cards when history only replaces streamed text", async () => {
    const persistedUser = textMessage("user", "latest ask", { seq: 1 });
    const historyAssistant = textMessage(
      "assistant",
      "First visible stream text. More final text.",
      { seq: 2 },
    );
    const liveToolMessage = {
      role: "assistant",
      toolCallId: "call_current",
      runId: "run-1",
      content: [{ type: "toolcall", name: "shell", arguments: {} }],
    };
    const state = createLiveToolHistoryState(
      [persistedUser, historyAssistant],
      {
        chatMessages: [persistedUser],
        chatRunId: "run-1",
        chatStream: "First visible stream text.",
        chatStreamStartedAt: 100,
      },
      [liveToolMessage],
      [{ text: "First visible stream text.", ts: 90 }],
    );

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([persistedUser, historyAssistant]);
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
    expect(state.chatToolMessages).toEqual([liveToolMessage]);
    expect(visibleParts(state)).toEqual([]);
    expect(state.toolStreamById.size).toBe(1);
    expect(state.toolStreamOrder).toEqual([buildToolStreamIdentity("run-1", "call_current")]);
  });

  it("shows a targeted message when chat history is unauthorized", async () => {
    const scopeError = missingScopeErrorShape({
      missingScope: "operator.read",
      requiredScopes: ["operator.read"],
    });
    const request = vi.fn().mockRejectedValue(new GatewayRequestError(scopeError));
    const state = createHistoryState(request, {
      chatMessages: [textMessage("assistant", "old")],
      chatThinkingLevel: "high",
      chatVerboseLevel: "full",
    });

    await loadChatHistory(state);

    expect(state.chatMessages).toStrictEqual([]);
    expect(state.chatThinkingLevel).toBeNull();
    expect(state.chatVerboseLevel).toBeNull();
    expect(getChatHistoryLoadState(state)).toMatchObject({
      phase: "failed",
      message:
        "This connection is missing operator.read, so existing chat history cannot be loaded yet.",
      retryable: false,
    });
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(state.chatLoading).toBe(false);
  });

  it("preserves late assistant messages when startup history only catches up to the user turn", async () => {
    const { history, request, state } = createDeferredHistoryState();

    const load = loadChatHistory(state);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    const userMessage = textMessage(
      "user",
      "send before history settles",
      { idempotencyKey: "late-run:user" },
      123,
    );
    const persistedUserMessage = textMessage(
      "user",
      "send before history settles",
      { id: "persisted-late-user", idempotencyKey: "late-run:user", seq: 1 },
      123,
    );
    const assistantMessage = textMessage(
      "assistant",
      "answer before history catches up",
      { id: "persisted-late-assistant", seq: 2 },
      456,
    );
    projectChatMessageEvent(state, {
      type: "sendPending",
      runId: "late-run",
      message: userMessage,
    });
    state.chatRunId = "late-run";
    state.chatStream = "";
    state.chatStreamStartedAt = 456;
    projectChatMessageEvent(state, {
      type: "messagePersisted",
      message: assistantMessage,
    });

    history.resolve({ messages: [persistedUserMessage], thinkingLevel: "low" });
    await load;

    expect(state.chatMessages).toEqual([persistedUserMessage, assistantMessage]);
    expect(state.chatRunId).toBe("late-run");
    expect(state.chatStream).toBe("");
    expect(state.chatStreamStartedAt).toBe(456);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatLoading).toBe(false);
  });

  it("refreshes history for a new pending source and coalesces unchanged receipt queries", async () => {
    const staleHistory = createDeferred<HistoryResult>();
    const currentHistory = createDeferred<HistoryResult>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => staleHistory.promise)
      .mockImplementationOnce(() => currentHistory.promise);
    const state = createHistoryState(request);

    const firstLoad = loadChatHistory(state);
    const pending = textMessage("user", "new local ask", {
      idempotencyKey: "same-session-pending-run:user",
    });
    projectChatMessageEvent(state, {
      type: "sendPending",
      runId: "same-session-pending-run",
      message: pending,
    });
    const secondLoad = loadChatHistory(state);
    const thirdLoad = loadChatHistory(state);

    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["chat.history", { sessionKey: "main", limit: 80, maxBytes: 256 * 1024 }],
    ]);
    expect(state.chatMessages).toEqual([pending]);

    staleHistory.resolve(createAssistantHistory("stale history"));
    await firstLoad;
    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["chat.history", { sessionKey: "main", limit: 80, maxBytes: 256 * 1024 }],
      [
        "chat.history",
        {
          sessionKey: "main",
          limit: 80,
          maxBytes: 256 * 1024,
          inputRunIds: ["same-session-pending-run"],
        },
      ],
    ]);
    expect(state.chatMessages).toEqual([pending]);
    expect(state.chatLoading).toBe(true);

    const persisted = textMessage("assistant", "persisted history", {
      id: "same-session-history-assistant",
      seq: 1,
    });
    currentHistory.resolve({ messages: [persisted] });
    await Promise.all([secondLoad, thirdLoad]);

    expect(request).toHaveBeenCalledTimes(2);
    expect(state.chatMessages).toEqual([persisted, pending]);
    expect(state.chatLoading).toBe(false);
  });

  it("rejects stale success and cleanup after a same-client reconnect", async () => {
    const staleRequest = createDeferred<HistoryResult>();
    const freshRequest = createDeferred<HistoryResult>();
    const request = vi
      .fn()
      .mockImplementationOnce(() => staleRequest.promise)
      .mockImplementationOnce(() => freshRequest.promise);
    const client = createTestClient(request);
    const visibleMessage = textMessage("assistant", "visible before reconnect");
    const state = createHistoryStateForClient(client, {
      chatMessages: [visibleMessage],
      connectionEpoch: 1,
    });

    const staleLoad = loadChatHistory(state);
    state.connected = false;
    state.connectionEpoch = 2;
    state.connected = true;
    state.connectionEpoch = 3;
    const freshLoad = loadChatHistory(state);

    expect(request).toHaveBeenCalledTimes(2);
    staleRequest.resolve(createAssistantHistory("stale history", { thinkingLevel: "high" }));
    await staleLoad;

    expect(state.chatMessages).toEqual([visibleMessage]);
    expect(state.chatThinkingLevel).toBeNull();
    expect(state.chatLoading).toBe(true);

    freshRequest.resolve(createAssistantHistory("fresh history", { thinkingLevel: "low" }));
    await freshLoad;

    expect(state.chatMessages).toEqual([textMessage("assistant", "fresh history")]);
    expect(state.chatThinkingLevel).toBe("low");
    expect(state.chatLoading).toBe(false);
  });

  it("rejects stale errors and cleanup after a same-client reconnect", async () => {
    const staleRequest = createDeferred<HistoryResult>();
    const request = vi.fn(() => staleRequest.promise);
    const client = createTestClient(request);
    const state = createHistoryStateForClient(client, {
      connectionEpoch: 1,
    });

    const staleLoad = loadChatHistory(state);
    state.connected = false;
    state.connectionEpoch = 2;
    state.connected = true;
    state.connectionEpoch = 3;
    state.chatLoading = true;
    staleRequest.reject(new Error("stale history failure"));
    await staleLoad;

    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(getChatHistoryLoadState(state)).toMatchObject({ phase: "pending-connection" });
    expect(state.chatLoading).toBe(true);
  });

  it("ignores stale global history responses after switching selected agents", async () => {
    const workRequest = createDeferred<HistoryResult>();
    const request = vi.fn((_method: string, params?: { agentId?: string; sessionKey?: string }) => {
      if (params?.sessionKey === "global" && params.agentId === "work") {
        return workRequest.promise;
      }
      throw new Error(`Unexpected request: ${JSON.stringify(params)}`);
    });
    const state = createHistoryState(request, {
      sessionKey: "global",
      assistantAgentId: "work",
      agentsList: { defaultId: "main" },
      chatMessages: [textMessage("assistant", "visible old")],
    });

    const load = loadChatHistory(state);
    state.assistantAgentId = "main";
    workRequest.resolve(createAssistantHistory("work history", { thinkingLevel: "high" }));
    await load;

    expect(state.chatLoading).toBe(false);
    expect(state.chatMessages).toEqual([textMessage("assistant", "visible old")]);
    expect(state.chatThinkingLevel).toBeNull();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

function createAbortDiagnosticState(runId = "run-validation-abort") {
  return createStateWithRunningSession({
    chatRunId: runId,
    chatStream: "Partial assistant reply",
    chatStreamStartedAt: 100,
    chatRunError: null,
  });
}

describe("aborted chat diagnostics", () => {
  it("keeps first-terminal provider sign-out killed and interrupted", () => {
    const stopReason = "auth-revoked";
    const expectedError =
      "Error: This reply stopped because the provider was signed out. Sign in again or choose another model.";

    const state = createAbortDiagnosticState();
    const payload: ChatEventPayload = chatEvent("aborted", {
      runId: "run-validation-abort",
      stopReason,
    });

    handleChatGatewayEvent(state, payload);

    expect(state.chatRunError?.summary ?? null).toBe(expectedError);
    expect(state.chatRunStatus).toMatchObject({
      phase: "interrupted",
      runId: "run-validation-abort",
      sessionKey: "main",
    });
    expect(state.lastLocalTerminalReconcile?.sessionStatus).toBe("killed");
    expect(state.sessionsResult?.sessions[0]).toMatchObject({
      activeRunIds: [],
      hasActiveRun: false,
      status: "killed",
    });
    expect(state.chatRunId).toBeNull();
  });

  it("surfaces one late aborted diagnostic and ignores its replay", () => {
    const state = createAbortDiagnosticState();
    const aborted = chatEvent("aborted", { runId: "run-validation-abort" });
    const diagnostic = {
      ...aborted,
      errorMessage: "edit tool validation failed: edits: must be an array",
    };

    handleChatGatewayEvent(state, aborted);
    expect(state.chatRunError).toBeNull();
    handleChatGatewayEvent(state, diagnostic);
    const displayedDiagnostic = state.chatRunError;
    handleChatGatewayEvent(state, diagnostic);

    expect(state.chatRunError).toBe(displayedDiagnostic);
    expect(state.chatRunError).toEqual({
      summary: "Error: edit tool validation failed: edits: must be an array",
      runId: "run-validation-abort",
    });
    expect(state.chatRunId).toBeNull();
  });

  it("does not restore an old diagnostic while a newer send awaits its ACK", () => {
    const state = createAbortDiagnosticState("run-old");
    receive(state, "aborted", { runId: "run-old" });
    state.chatQueue = [
      {
        id: "pending-new-send",
        text: "New request",
        createdAt: 200,
        sendRunId: "run-new",
        sendState: "sending",
      },
    ];

    receive(state, "aborted", {
      runId: "run-old",
      errorMessage: "edit tool validation failed: invalid arguments",
    });

    expect(state.chatRunError).toBeNull();
    expect(state.chatRunId).toBeNull();
    expect(state.lastLocalTerminalReconcile?.runId).toBe("run-old");
  });

  it("does not publish an old aborted diagnostic after a newer run completes", () => {
    const state = createAbortDiagnosticState("run-old");
    receive(state, "aborted", { runId: "run-old" });
    state.chatRunId = "run-new";
    state.chatStream = "New final answer";
    receive(state, "final", {
      runId: "run-new",
      message: textMessage("assistant", "New final answer"),
    });

    receive(state, "aborted", {
      runId: "run-old",
      errorMessage: "edit tool validation failed: invalid arguments",
    });

    expect(state.chatRunError).toBeNull();
    expect(state.lastLocalTerminalReconcile?.runId).toBe("run-new");
    expect(state.chatRunId).toBeNull();
    expect(state.chatMessages.at(-1)).toMatchObject(textMessage("assistant", "New final answer"));
  });
});
