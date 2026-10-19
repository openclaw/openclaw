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

const historyBudget = { limit: 80, maxBytes: 256 * 1024, toolResultMaxChars: 2_000 };

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

function renderedMessageTexts(state: ChatState, paneId: string) {
  return buildChatItems({
    paneId,
    sessionKey: state.sessionKey,
    runId: state.chatRunId,
    messages: state.chatMessages,
    toolMessages: [],
    streamSegments: state.chatStreamSegments ?? [],
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
    chatStreamSegments: [],
    chatToolMessages: [],
    toolStreamById: new Map(),
    toolStreamOrder: [],
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

it("keeps a diagnostic-only internal failure out of live and reloaded retry banners", async () => {
  const user = textMessage("user", "Publish the fix", { id: "request", seq: 1, runId: "user-run" });
  const answer = textMessage("assistant", "The fix is published.", {
    id: "answer",
    seq: 2,
    runId: "user-run",
  });
  const errorMessage = "No answer was returned. Ask again if you still need one.";
  const state = createState({ chatMessages: [user, answer] });
  receive(state, "error", { runId: "internal-run", errorMessage, suppressErrorNotice: true });
  expect(state.chatRunError).toBeNull();
  expect(getChatSessionProjection(state).runs["internal-run"]).toMatchObject({ status: "error" });
  expect(getChatSessionProjection(state).runs["internal-run"]?.errorMessage).toBeUndefined();
  expect(state.chatMessages).toEqual([user, answer]);
  const sessionInfo = {
    key: "main",
    kind: "direct",
    sessionId: "session",
    updatedAt: 3,
    status: "failed",
    lastRunId: "internal-run",
    lastRunError: errorMessage,
    suppressErrorNotice: true,
    hasActiveRun: false,
  } as const;
  const reloaded = createHistoryState(
    vi.fn(async () => ({ messages: [user, answer], sessionInfo })),
  );
  await loadChatHistory(reloaded);
  expect(reloaded.chatRunError?.summary).toBeUndefined();
  expect(reloaded.chatMessages).toEqual([user, answer]);
  expect(getChatSessionProjection(reloaded).runs["internal-run"]).toMatchObject({
    status: "error",
  });
  expect(getChatSessionProjection(reloaded).runs["internal-run"]?.errorMessage).toBeUndefined();
  const attached = createStateWithRunningSession({ chatRunId: "internal-run" });
  attached.sessionsResult = { ...attached.sessionsResult, sessions: [sessionInfo] };
  reconcileChatRunAfterSessionStatePublication(attached);
  expect(attached.chatRunError?.summary).toBeUndefined();
  expect(attached.chatRunId).toBeNull();
});

it.each([true, false])(
  "keeps identical injected notes separate without adopting a run (persisted first=%s)",
  (persistedFirst) => {
    const user = textMessage("user", "Previous question", { id: "user", seq: 1 });
    const reply = textMessage("assistant", "Previous reply", { id: "reply", seq: 2 });
    const state = createState({ chatMessages: [user, reply] });
    const ids = ["note-one", "note-two"];
    const notes = ids.map((id, index) =>
      textMessage("assistant", "Synthetic weekly report", { id, seq: index + 3 }),
    );
    for (const [index, saved] of notes.entries()) {
      if (persistedFirst) {
        applySessionMessagePayload(state, { message: saved }, false, { kind: "history-delta" });
      }
      const event = {
        runId: `inject-${ids[index]}`,
        seq: 0,
        message: textMessage("assistant", "Synthetic weekly report"),
      };
      receive(state, "final", event);
      receive(state, "final", event);
      if (!persistedFirst) {
        applySessionMessagePayload(state, { message: saved }, false, { kind: "history-delta" });
      }
      expect(state.chatMessages).toEqual([user, reply, ...notes.slice(0, index + 1)]);
      expectSettled(state);
      expect(Object.keys(getChatSessionProjection(state).runs)).toEqual([]);
    }
    expect(renderedMessageTexts(state, "injected-notes")).toEqual([
      "Previous question",
      "Previous reply",
      "Synthetic weekly report",
      "Synthetic weekly report",
    ]);
  },
);

it.each([{ persistedFirst: true, transformed: true }])(
  "settles a saved interrupted partial once with both error emitters (persisted first=$persistedFirst, transformed=$transformed)",
  () => {
    const runId = "interrupted-run";
    const text = "The saved partial reply should appear once.";
    const user = textMessage("user", "Ask", { id: "user", seq: 1, runId });
    const saved = {
      role: "assistant",
      content: [
        { type: "text", text: "Saved transformed text" },
        { type: "image", source: { type: "url", url: "https://example.test/proof.png" } },
      ],
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
    persist();
    receive(state, "error", {
      runId,
      seq: 13,
      errorMessage: "codex app-server client closed before turn completed",
      message: textMessage("assistant", text, { runId, idempotencyKey: "saved-key" }),
    });
    receive(state, "error", { runId, seq: 1, errorMessage: "Outer returned failure" });
    expect(state.chatMessages).toEqual([user, saved]);
    expect(state.chatRunError?.summary).toBeTruthy();
    const restored = createState({ chatMessages: structuredClone(state.chatMessages) });
    applySessionMessagePayload(restored, { runId, message: saved }, true, {
      kind: "history-delta",
    });
    expect(restored.chatMessages).toEqual([user, saved]);
  },
);

it("keeps a later final distinct after an unpositioned steer", () => {
  const runId = "run-1";
  const state = createState({
    chatRunId: runId,
    chatMessages: [
      textMessage("user", "Ask", { id: "prompt", seq: 1, idempotencyKey: "run-1:user" }, 1),
      textMessage(
        "user",
        "Earlier steer",
        {
          id: "earlier-steer",
          seq: 2,
          idempotencyKey: "earlier:user",
          steerTargetRunId: runId,
        },
        2,
      ),
      textMessage("assistant", "Earlier answer", { id: "earlier-answer", seq: 3, runId }, 3),
    ],
  });
  applySessionMessagePayload(
    state,
    {
      clientRunId: runId,
      messageId: "latest-steer",
      message: textMessage(
        "user",
        "Latest steer",
        {
          idempotencyKey: "latest:user",
          steerTargetRunId: runId,
        },
        4,
      ),
    },
    true,
    { kind: "live", activeRunId: runId },
  );
  receive(state, "final", {
    message: textMessage("assistant", "New final", undefined, 5),
  });
  expect(state.chatMessages.map(extractText)).toEqual([
    "Ask",
    "Earlier steer",
    "Earlier answer",
    "Latest steer",
    "New final",
  ]);
});

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

  it("keeps preparation, model wait, and answer status monotonic through an empty replacement", () => {
    const state = createState({ chatRunId: "run-1", chatStream: "" });
    const label = () =>
      chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null);
    receive(state, "status", { phase: "preparing_context", seq: 1 });
    expect(label()).toBe("Preparing this turn…");
    receive(state, "delta", {
      runId: "run-other",
      message: { role: "assistant", content: "Other" },
    });
    expect(label()).toBe("Preparing this turn…");
    receive(state, "status", { phase: "starting_model", seq: 2 });
    expect(label()).toBe("Waiting for a response");
    receive(state, "status", { phase: "preparing_context", seq: 3 });
    expect(label()).toBe("Waiting for a response");
    receive(state, "delta", { message: { role: "assistant", content: "Hello" } });
    expect(state.chatRunStartup).toEqual({
      state: "status",
      phase: "answer",
      runId: "run-1",
      seq: 2,
    });
    receive(state, "delta", { replace: true, message: { role: "assistant", content: "" } });
    receive(state, "status", { phase: "preparing_context", seq: 4 });
    expect(state.chatRunStartup).toMatchObject({ phase: "answer" });
    expect(label()).toBeUndefined();
    expect(state.chatRunId).toBe("run-1");
  });

  it.each([true])(
    "appends one background final across three panes (display projection=%s)",
    (projected) => {
      const cache = new Map();
      const states = ["one", "two", "three"].map((sessionKey) =>
        createState({ chatMessagesBySession: cache, sessionKey }),
      );
      const payload: ChatEventPayload = chatEvent("final", {
        sessionKey: "background",
        message: projected
          ? {
              ...textMessage("assistant", "complete delivery result"),
              openclawDisplayContent: [{ type: "text", text: "background final" }],
            }
          : textMessage("assistant", "background final"),
      });
      seedChatSnapshot(states[0]!, { sessionKey: "background" });

      for (const state of states) {
        handleChatGatewayEvent(state, payload);
      }

      expect(readChatMessagesFromCache(cache, states[0]!, { sessionKey: "background" })).toEqual([
        textMessage("assistant", "background final"),
      ]);
    },
  );

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

  it.each([
    {
      name: "retracts the stream when a replacement snapshot is empty",
      previous: "Draft",
      delta: "",
      snapshot: "",
      replace: true,
      expected: "",
    },
    {
      name: "preserves a prepared literal marker in a replacement tail",
      previous: "The token is ",
      delta: "",
      snapshot: "NO_REPLY",
      replace: true,
      expected: "NO_REPLY",
    },
  ])("$name", ({ previous, delta, snapshot, replace, expected }) => {
    const state = createState({
      chatRunId: "run-1",
      chatStream: previous,
    });
    const payload: ChatEventPayload = chatEvent("delta", {
      deltaText: delta,
      message: textMessage("assistant", snapshot),
      ...(replace ? { replace: true } : {}),
    });

    handleChatGatewayEvent(state, payload);
    expect(state.chatStream).toBe(expected);
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

  it("preserves one durable keyed commentary row when a steered run finishes", () => {
    const state = createState({
      chatRunId: "run-1",
      chatMessages: [
        textMessage("user", "Ask", { idempotencyKey: "run-1:user" }, 1),
        {
          role: "assistant",
          content: [{ type: "text", text: "Looking into it." }],
          timestamp: 2,
          openclawStreamFallback: {
            itemId: "preamble-1",
            runId: "run-1",
            replacementText: "Looking into it.",
            source: "segment",
          },
        },
        textMessage(
          "user",
          "Focus on deployment",
          { idempotencyKey: "steer-send-1:user", steerTargetRunId: "run-1" },
          3,
        ),
      ],
    });
    state.chatStreamSegments = [
      {
        text: "Looking into it.",
        ts: 2,
        itemId: "preamble-1",
        runId: "run-1",
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

  it("keeps the complete terminal reply after an accepted steer when no later delta arrived", () => {
    const state = createState({
      chatRunId: "run-1",
      chatStream: "Before steer.",
      chatStreamStartedAt: 2,
      chatMessages: [
        textMessage("user", "Ask", { idempotencyKey: "run-1:user" }, 1),
        textMessage(
          "user",
          "Steer",
          {
            idempotencyKey: "steer-1:user",
            steerTargetRunId: "run-1",
          },
          3,
        ),
      ],
    });

    receive(state, "final", {
      message: textMessage("assistant", "Before steer. Final unseen suffix.", undefined, 4),
    });

    expect(state.chatMessages).toHaveLength(3);
    expectTextMessage(state.chatMessages[0], "user", "Ask");
    expectTextMessage(state.chatMessages[1], "user", "Steer");
    expectTextMessage(state.chatMessages[2], "assistant", "Before steer. Final unseen suffix.");
    const rendered = buildChatItems({
      paneId: "terminal-after-steer",
      sessionKey: state.sessionKey,
      runId: state.chatRunId,
      messages: state.chatMessages,
      toolMessages: [],
      streamSegments: [],
      stream: state.chatStream,
      streamStartedAt: state.chatStreamStartedAt,
      showToolCalls: true,
    }).flatMap((item) =>
      item.kind === "group" ? item.messages.map(({ message }) => extractText(message)) : [],
    );
    expect(rendered).toEqual(["Ask", "Steer", "Before steer. Final unseen suffix."]);
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
      name: "restart interruption",
      event: { state: "aborted", stopReason: "restart" },
      projectionStatus: "aborted",
      sessionStatus: "interrupted",
      errorSummary: null,
    },
    {
      name: "ordinary Stop",
      event: { state: "aborted" },
      projectionStatus: "aborted",
      sessionStatus: "killed",
      errorSummary: null,
    },
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

  it("keeps active stream for unowned final payloads", () => {
    const state = createActiveStreamingState();
    const payload: ChatEventPayload = chatEvent("final", { runId: undefined });

    handleChatGatewayEvent(state, payload);
    expect(state.chatRunId).toBe("run-user");
    expect(state.chatStream).toBe("Working...");
    expect(state.chatStreamStartedAt).toBe(123);
    expect(state.chatMessages).toStrictEqual([]);
  });

  type TerminalErrorFixture = {
    stream?: string | null;
    previous?: ReturnType<typeof textMessage>[];
    segments?: ChatState["chatStreamSegments"];
    message?: Record<string, unknown>;
    expected: Array<readonly ["assistant" | "user", string]>;
    verify?: (state: ChatState) => void;
  };

  it.each([
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

  it.each([
    [
      "openai",
      429,
      "subscription_sharing_workplace_individual_usage_limit_exceeded",
      "chatgpt_business_usage_limit",
    ],
    ["openai", 429, "subscription_sharing_usage_limit_exceeded", "chatgpt_consumer_usage_limit"],
    ["openai", 429, "rate_limit_exceeded", undefined],
    ["openai", 403, "subscription_sharing_workplace_individual_usage_limit_exceeded", undefined],
    ["openai", 403, "subscription_sharing_usage_limit_exceeded", undefined],
    ["other", 429, "subscription_sharing_workplace_individual_usage_limit_exceeded", undefined],
    ["other", 429, "subscription_sharing_usage_limit_exceeded", undefined],
  ])(
    "classifies ChatGPT sharing limits only from provider facts (%s, %s, %s)",
    (provider, httpStatus, providerErrorCode, kind) => {
      const state = createState({ chatRunId: "run-1" });
      receive(state, "error", {
        errorMessage: "Usage limit reached",
        errorDetail: { provider, httpStatus, providerErrorCode },
      });
      expect(state.chatRunError?.kind).toBe(kind);
      expect(state.chatRunError?.runId).toBe("run-1");
    },
  );

  it.each([
    [
      "subscription_sharing_workplace_individual_usage_limit_exceeded",
      "chatgpt_business_usage_limit",
    ],
    ["subscription_sharing_usage_limit_exceeded", "chatgpt_consumer_usage_limit"],
  ])(
    "adopts %s recovery after history publishes the same terminal summary",
    (providerErrorCode, kind) => {
      const summary = "Usage limit reached";
      const state = createState({
        chatRunId: "run-1",
        chatRunError: { runId: "run-1", summary },
      });
      const scope = { sessionKey: state.sessionKey };
      publishChatSessionProjection(
        state,
        reduceSessionProjection(getChatSessionProjection(state, scope), {
          type: "runTerminal",
          runId: "run-1",
          status: "error",
          errorMessage: summary,
          scope,
        }),
      );
      receive(state, "error", {
        errorMessage: summary,
        errorDetail: {
          provider: "openai",
          httpStatus: 429,
          providerErrorCode,
        },
      });
      expect(state.chatRunError?.kind).toBe(kind);
      expect(state.chatRunError?.runId).toBe("run-1");
    },
  );

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

  it.each(["delta"] as const)("replaces retry progress and clears it on %s", (terminalState) => {
    const state = createState({ chatRunId: "run-retry" });
    const envelope = { sessionKey: "main", runId: "run-retry" };
    receive(state, "delta", { ...envelope, deltaText: "" });
    for (const attempt of [2, 3]) {
      receive(state, "status", {
        ...envelope,
        seq: attempt,
        retry: { attempt, maxAttempts: 10, reason: "rate_limit", retryAt: 10_000 + attempt },
      });
      expect(chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null)).toBe(
        "Retrying…",
      );
      expect(state.chatRunStartup).toMatchObject({
        phase: "retrying",
        retryAt: 10_000 + attempt,
        seq: attempt,
      });
      expect(state.chatMessages).toEqual([]);
      expect(state.chatRunError).toBeFalsy();
    }
    handleChatGatewayEvent(state, { ...envelope, state: terminalState });
    expect(activeChatRunStartupStatus(state.chatRunStartup)).toBeNull();
  });

  it.each([
    {
      name: "normalized assistant role",
      role: " Assistant ",
      content: [{ type: "text", text: "⚠️ Error: provider rate limit" }],
    },
  ])("keeps resumed deltas in one reply after repeated $name errors", ({ content, role }) => {
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
  });
});

describe("authoritative terminal history identity", () => {
  it.each([false, true])(
    "keeps the live pairing QR through history refreshes (history first=%s)",
    async (historyFirst) => {
      const text =
        "Scan this QR code with the OpenClaw iOS app:\n\n- Gateway: wss://pair.example.invalid\n- Auth: token\n- Security: single-use bootstrap token";
      const saved = textMessage("assistant", text, { id: "pair-reply", seq: 2, runId: "run-1" });
      const qr = {
        type: "openclaw_pairing_qr",
        image_url: "data:image/png;base64,c3ludGhldGljLXFy",
        alt: "OpenClaw pairing QR code",
        expiresAtMs: Date.now() + 600_000,
        sensitive: true,
      };
      const live = { ...saved, content: [{ type: "text", text }, qr] };
      const { state, request } = createResolvedHistoryState(
        { messages: [saved], sessionId: "pair-session" },
        { chatRunId: "run-1", currentSessionId: "pair-session" },
      );
      if (historyFirst) {
        rememberAuthoritativeTerminal({
          host: state,
          event: { key: "main", runId: "run-1", hasActiveRun: false },
          payload: { message: saved },
          matchesChat: true,
          runIdBeforeApply: "run-1",
        });
        await loadChatHistory(state);
        expect(authoritativeHistoryAppliedForRun(state, "run-1")).toBe(true);
      }
      receive(state, "final", { message: live });
      expect(state.chatMessages).toEqual([live]);
      for (let refresh = 0; refresh < 2; refresh += 1) {
        await loadChatHistory(state);
        expect(state.chatMessages).toEqual([live]);
      }
      const revised = { ...saved, content: [{ type: "text", text: "Updated pairing details" }] };
      applySessionMessagePayload(state, { message: revised }, false, { kind: "history-delta" });
      expect(state.chatMessages).toEqual([{ ...revised, content: [...revised.content, qr] }]);
      request.mockResolvedValue({ messages: [revised], sessionId: "pair-session" });
      await loadChatHistory(state);
      request.mockResolvedValue({ messages: [], sessionId: "pair-session" });
      await loadChatHistory(state);
      expect(state.chatMessages).toEqual([]);
    },
  );

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
  it("trusts prepared history text while filtering synthetic rows and heartbeat acknowledgments", async () => {
    const repair =
      "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair.";
    const visible = [
      textMessage("user", "NO_REPLY"),
      textMessage("user", repair),
      textMessage("assistant", "no_reply"),
      textMessage("assistant", "NO_REPLY"),
      { role: "assistant", text: "  NO_REPLY  " },
      textMessage("assistant", "NO_REPLY."),
      textMessage("assistant", '{"action":"NO_REPLY"}'),
      textMessage("assistant", "I will not reply: NO_REPLY"),
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
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "ops",
              mainKey: "main",
              mainSessionKey: "agent:ops:main",
            },
          },
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
});

describe("loadChatHistory retry handling", () => {
  it("expires shared startup readers together and allows an explicit retry", async () => {
    const unavailable = new GatewayRequestError({
      code: "UNAVAILABLE",
      message: "chat.history unavailable during gateway startup",
      details: { method: "chat.history" },
      retryable: true,
      retryAfterMs: 59_000,
    });
    const secondAttempt = createDeferred<unknown>();
    const request = vi
      .fn()
      .mockRejectedValueOnce(unavailable)
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
    await Promise.all([firstLoad, secondLoad]);
    for (const state of [firstState, secondState]) {
      expect(state.chatLoading).toBe(false);
      expect(getChatHistoryLoadState(state)).toMatchObject({
        phase: "failed",
        message: expect.stringContaining("timed out"),
      });
    }
    expect(request.mock.calls[1]?.[2]?.signal.aborted).toBe(true);
    await loadChatHistory(secondState);

    expect(request).toHaveBeenCalledTimes(3);
    expect(secondState.chatMessages).toEqual([textMessage("assistant", "awake")]);
    expect(firstState.chatMessages).toEqual([]);
    secondAttempt.resolve(createAssistantHistory("expired"));
    await vi.advanceTimersByTimeAsync(0);
    expect(secondState.chatMessages).toEqual([textMessage("assistant", "awake")]);
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

  it("places materialized streamed text after a persisted user prompt with a later clock", async () => {
    // Prompt and stream timestamps come from different clocks, so the prompt can be the later one.
    // The user turn owns placement; retiming the saved stream would reorder live tools.
    const userTimestamp = 200;
    const streamTimestamp = 100;

    const persistedUser = textMessage("user", "first", { seq: 1 }, userTimestamp);
    const { state } = createHistorySnapshot([persistedUser], {
      chatMessages: [persistedUser],
      chatRunId: null,
      chatStream: "Partial answer before history catch-up.",
      chatStreamStartedAt: streamTimestamp,
    });

    await loadChatHistory(state);
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[0]).toEqual(persistedUser);
    expectTextMessage(
      state.chatMessages[1],
      "assistant",
      "Partial answer before history catch-up.",
    );
    expect(renderedMessageTexts(state, "materialized-stream-order")).toEqual([
      "first",
      "Partial answer before history catch-up.",
    ]);
    expect(requireRecord(state.chatMessages[1]).timestamp).toBe(streamTimestamp);
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBeNull();
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
        "You don't have permission to view existing chat history. Ask the person who manages OpenClaw for access.",
      retryable: false,
    });
    expect(state.lastError).toBeNull();
    expect(state.chatError).toBeNull();
    expect(state.chatLoading).toBe(false);
  });

  it("refreshes history for a new pending source and coalesces unchanged receipt queries", async () => {
    const staleHistory = createDeferred<HistoryResult>();
    const currentHistory = createDeferred<HistoryResult>();
    const currentHistoryStarted = createDeferred();
    const request = vi
      .fn()
      .mockImplementationOnce(() => staleHistory.promise)
      .mockImplementationOnce(() => {
        currentHistoryStarted.resolve();
        return currentHistory.promise;
      });
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
      ["chat.history", { sessionKey: "main", ...historyBudget, knownState: {} }],
    ]);
    expect(state.chatMessages).toEqual([pending]);

    staleHistory.resolve(createAssistantHistory("stale history"));
    await currentHistoryStarted.promise;
    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["chat.history", { sessionKey: "main", ...historyBudget, knownState: {} }],
      [
        "chat.history",
        {
          sessionKey: "main",
          ...historyBudget,
          knownState: {},
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
    await Promise.all([firstLoad, secondLoad, thirdLoad]);

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
