/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://127.0.0.1:18789/chat/main/current"} */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { EarlyGateway } from "../../api/gateway-boot.ts";
import {
  getLatestWebSocket,
  MockWebSocket,
  useNodeFakeTimers,
  wsInstances,
} from "../../api/gateway-socket.test-support.ts";
import { makeBootRoster } from "../../app/bootstrap.test-support.ts";
import { loadSettings, saveSettings } from "../../app/settings.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { chatHistoryRequestParams } from "./chat-history-request-params.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { makeRequestMock, requestCalls } from "./chat-host.test-support.ts";
import { createTestChatPane, getPaneTestRuntime } from "./chat-pane.test-support.ts";
import { resetThreadPresentation } from "./components/chat-thread-interactions.ts";
import { buildToolStreamIdentity } from "./tool-stream-identity.ts";

beforeEach(() => {
  const style = document.documentElement.getAttribute("style");
  onTestFinished(() => {
    if (style === null) {
      document.documentElement.removeAttribute("style");
    } else {
      document.documentElement.setAttribute("style", style);
    }
  });
  useNodeFakeTimers();
  wsInstances.length = 0;
  vi.stubGlobal("WebSocket", MockWebSocket);
  let requestId = 0;
  vi.stubGlobal("crypto", { randomUUID: () => `early-pane-${++requestId}` });
});

afterEach(() => {
  resetThreadPresentation();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps the initial transcript and buffered streaming final exactly once in the real pane", async () => {
  const key = "agent:main:current";
  const runId = "boot-stream-run";
  const row = {
    key,
    sessionId: "boot-session",
    kind: "direct" as const,
    updatedAt: 1,
    hasActiveRun: true,
    activeRunIds: [runId],
    status: "running" as const,
  };
  const history: ChatHistoryResult = {
    messages: [
      {
        role: "user",
        content: "Initial question",
        __openclaw: { id: "boot-question", seq: 1 },
      },
    ],
    sessionId: row.sessionId,
    sessionInfo: row,
    inFlightRun: { runId, text: "", startedAt: 1 },
  };
  const request = makeRequestMock({
    connect: sessionMutationGatewayHello(),
    "agents.list": makeBootRoster(),
    "sessions.list": sessionsResult([row], 1),
    "sessions.describe": { session: row },
    "sessions.subscribe": { subscribed: true },
    "sessions.messages.subscribe": (params: {
      key: string;
      initialHistory?: unknown;
      includeApprovals?: boolean;
    }) => ({
      key: params.key,
      ...(params.initialHistory ? { initialHistory: { ok: true, payload: history } } : {}),
      ...(params.includeApprovals ? { approvalReplay: { sessionKey: key, approvals: [] } } : {}),
    }),
    "chat.metadata": { commands: [] },
    "models.authStatus": { ts: 1, providers: [] },
    "sessions.branches.list": { branches: [] },
    "question.list": { questions: [] },
    "taskSuggestions.list": { suggestions: [] },
    "session.suggestions.list": { suggestions: [] },
    "sessions.companion.state": { exchanges: [] },
  });
  const {
    sessionKey: _key,
    agentId: _agent,
    ...initialHistory
  } = chatHistoryRequestParams("chat.startup", key, undefined);
  const options = { url: "ws://127.0.0.1:18789", token: "synthetic-token" };
  const early = new EarlyGateway(options, key, initialHistory, window.location.href);
  const socket = getLatestWebSocket();
  const send = socket.send.bind(socket);
  vi.spyOn(socket, "send").mockImplementation((data: string) => {
    send(data);
    const frame = JSON.parse(data) as { id: string; method: string; params?: unknown };
    void Promise.resolve(request(frame.method, frame.params)).then((payload) => {
      socket.emitMessage({ type: "res", id: frame.id, ok: true, payload });
    });
  });
  socket.emitOpen();
  socket.emitConnectChallenge({ nonce: "boot-pane", ts: 1_800_000_000_000 });
  await vi.advanceTimersByTimeAsync(0);

  const payload = { sessionKey: key, runId };
  socket.emitMessage({
    type: "event",
    event: "chat",
    seq: 1,
    payload: {
      ...payload,
      state: "delta",
      seq: 1,
      message: { role: "assistant", content: [{ type: "text", text: "Buffered" }] },
    },
  });
  socket.emitMessage({
    type: "event",
    event: "chat",
    seq: 2,
    payload: { ...payload, state: "delta", seq: 2, deltaText: " answer." },
  });
  socket.emitMessage({
    type: "event",
    event: "chat",
    seq: 3,
    payload: {
      ...payload,
      state: "final",
      seq: 3,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Buffered answer." }],
        __openclaw: { id: "boot-answer", runId },
      },
    },
  });

  const { pane, emitGatewayEvent } = createTestChatPane({ client: early.client });
  onTestFinished(() => early.client.stop());
  pane.sessionKey = key;
  // The shared fixture starts connected; a newly mounted production pane has no claimed client.
  pane.connectedClient = null;
  expect(
    early.adopt({
      ...options,
      onEvent: (event) => emitGatewayEvent(event.event, event.payload),
    }),
  ).toBe(early.client);
  // Run the production pane lifecycle, including its Gateway event listeners and history owner.
  getPaneTestRuntime(pane).start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    expect(getChatHistoryLoadState(pane.state).phase).toBe("committed");
    expect(pane.state.chatMessages.map((message) => extractText(message))).toEqual([
      "Initial question",
      "Buffered answer.",
    ]);
    expect(pane.state.chatRunId).toBeNull();
    expect(pane.state.chatStream).toBeNull();
  });
  expect(requestCalls(request, "chat.startup")).toHaveLength(0);
  expect(requestCalls(request, "chat.history")).toHaveLength(0);
  expect(
    requestCalls(request, "sessions.messages.subscribe").filter(
      ([, params]) => (params as { initialHistory?: unknown }).initialHistory !== undefined,
    ),
  ).toHaveLength(1);
  expect(wsInstances).toHaveLength(1);
});

it("retains quiet stdout and buffered updates until the prepared inline pane takes one subscription", async () => {
  // The pane fixture owns this Gateway's preferences, independently of the page URL.
  const settings = loadSettings("ws://example.test");
  onTestFinished(() => saveSettings(settings, { selectGateway: false }));
  saveSettings({ ...settings, chatInlineCommands: true }, { selectGateway: false });
  const key = "agent:main:current";
  const runId = "boot-tool-run";
  const row = {
    key,
    sessionId: "boot-tool-session",
    kind: "direct" as const,
    updatedAt: 1,
    hasActiveRun: true,
    activeRunIds: [runId],
    status: "running" as const,
  };
  const output = (toolCallId: string, seq: number, text: string) => ({
    sessionKey: key,
    runId,
    seq,
    ts: seq,
    stream: "tool",
    data: { toolCallId, name: "exec", phase: "update", outputOnly: true, partialResult: text },
  });
  const history: ChatHistoryResult = {
    messages: [{ role: "user", content: "Run the commands" }],
    sessionId: row.sessionId,
    sessionInfo: row,
    inFlightRun: {
      runId,
      text: "",
      startedAt: 1,
      events: [output("quiet", 1, "Quiet stdout"), output("streaming", 2, "Snapshot stdout")],
    },
  };
  const options = { url: "ws://127.0.0.1:18789", token: "synthetic-token" };
  const {
    sessionKey: _key,
    agentId: _agent,
    ...initialHistory
  } = chatHistoryRequestParams("chat.startup", key, undefined);
  const early = new EarlyGateway(options, key, initialHistory, window.location.href, true);
  onTestFinished(() => early.client.stop());
  const socket = getLatestWebSocket();
  const emitOutput = (seq: number, text: string) =>
    socket.emitMessage({
      type: "event",
      event: "agent",
      seq,
      payload: output("streaming", seq, text),
    });
  const request = makeRequestMock({
    connect: sessionMutationGatewayHello(),
    "agents.list": makeBootRoster(),
    "sessions.list": sessionsResult([row], 1),
    "sessions.describe": { session: row },
    "sessions.messages.subscribe": (params: { includeLiveToolOutput?: boolean }) => {
      expect(params.includeLiveToolOutput).toBe(true);
      emitOutput(3, "Before response");
      return { key, initialHistory: { ok: true, payload: history } };
    },
  });
  const send = socket.send.bind(socket);
  vi.spyOn(socket, "send").mockImplementation((data: string) => {
    send(data);
    const frame = JSON.parse(data) as { id: string; method: string; params?: unknown };
    void Promise.resolve(request(frame.method, frame.params)).then((payload) => {
      socket.emitMessage({ type: "res", id: frame.id, ok: true, payload });
    });
  });
  socket.emitOpen();
  socket.emitConnectChallenge({ nonce: "boot-tools", ts: 1_800_000_000_000 });
  await vi.advanceTimersByTimeAsync(0);
  await vi.dynamicImportSettled();
  emitOutput(4, "After response");

  const { pane, emitGatewayEvent } = createTestChatPane({ client: early.client });
  expect(pane.context.theme.settings.chatInlineCommands).toBe(true);
  pane.sessionKey = key;
  pane.connectedClient = null;
  const onEvent = vi.fn((event) => emitGatewayEvent(event.event, event.payload));
  expect(early.adopt({ ...options, onEvent })).toBe(early.client);
  await vi.advanceTimersByTimeAsync(0);
  expect(onEvent).not.toHaveBeenCalled();
  expect(pane.state.toolStreamById.size).toBe(0);

  getPaneTestRuntime(pane).start();
  await vi.advanceTimersByTimeAsync(0);
  await vi.dynamicImportSettled();
  await waitForSolid(() => {
    expect(getChatHistoryLoadState(pane.state).phase).toBe("committed");
    expect(pane.state.toolStreamById.get(buildToolStreamIdentity(runId, "quiet"))?.output).toBe(
      "Quiet stdout",
    );
    expect(pane.state.toolStreamById.get(buildToolStreamIdentity(runId, "streaming"))?.output).toBe(
      "After response",
    );
  });
  socket.emitMessage({
    type: "event",
    event: "agent",
    seq: 5,
    payload: {
      ...output("streaming", 5, ""),
      data: { toolCallId: "streaming", name: "exec", phase: "result", result: "Final stdout" },
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(pane.state.toolStreamById.get(buildToolStreamIdentity(runId, "streaming"))?.output).toBe(
    "Final stdout",
  );
  expect(requestCalls(request, "sessions.messages.subscribe")).toHaveLength(1);
  expect(requestCalls(request, "chat.startup")).toHaveLength(0);
  expect(requestCalls(request, "chat.history")).toHaveLength(0);
  expect(onEvent).toHaveBeenCalledTimes(3);
  expect(wsInstances).toHaveLength(1);
});
