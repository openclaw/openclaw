// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import type { ChatHistoryResponse } from "./chat-history-snapshot.ts";
import {
  activeHistory,
  createState,
  delayed,
  emit,
  event,
  failedHistory,
  message,
  renderedText,
  steerPrompts,
  tail,
  toolEvent,
  type TestState,
} from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  admitChatSubmission,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
} from "./history-merge.ts";
import {
  adoptStartedChatRun,
  handleAbortChat,
  reconcileChatRunLifecycle,
} from "./run-lifecycle.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { handleAgentEvent } from "./tool-stream.ts";
import { buildInitialChatSubmission } from "./user-message-content.ts";

function assistant(
  state: TestState,
  runId: string,
  text: string,
  fields: Partial<Omit<Parameters<typeof emit>[2], "message">> = {},
) {
  emit(state, runId, { state: "delta", ...fields, message: message("assistant", text) });
}

function publish(
  state: TestState,
  runId: string,
  payload: Parameters<typeof applySessionMessagePayload>[1],
) {
  applySessionMessagePayload(state, payload, true, { kind: "live", activeRunId: runId });
}

async function loadWithTools(state: TestState) {
  vi.stubGlobal("window", globalThis);
  try {
    await loadChatHistory(state);
    await vi.waitFor(() => expect(state.chatToolMessages).toHaveLength(1));
  } finally {
    vi.unstubAllGlobals();
  }
}

it.each([
  ["waiting_for_model", "First result.", "slot"],
  ["waiting_for_state", "", undefined],
] as const)("restores %s without a retry or a new run", async (phase, text, waitReason) => {
  const history = activeHistory("run-live");
  history.inFlightRun!.text = text;
  history.inFlightRun!.events = [
    event(3, "run_status", { phase, ...(waitReason ? { reason: waitReason } : {}) }),
  ];
  const state = createState(history);
  state.chatMessage = "Unsent draft";
  const request = vi.spyOn(state.client!, "request");
  await loadChatHistory(state);
  expect(state.chatRunStartup).toEqual({
    state: "status",
    runId: "run-live",
    phase,
    ...(waitReason ? { waitReason } : {}),
    seq: 3,
  });
  expect(state).toMatchObject({ chatRunId: "run-live", chatMessage: "Unsent draft" });
  expect(state.chatRunError).toBeFalsy();
  expect(request.mock.calls.some(([method]) => method === "chat.history")).toBe(true);
  expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
});

it("retires an interrupted run after missing its live terminal", async () => {
  const history = activeHistory("run-interrupted");
  const state = createState(history);
  vi.spyOn(state.client!, "request")
    .mockResolvedValueOnce(history)
    .mockResolvedValueOnce({
      messages: [],
      sessionInfo: {
        ...history.sessionInfo!,
        hasActiveRun: false,
        activeRunIds: [],
        lastRunId: "run-interrupted",
        status: "killed",
      },
      pendingInputs: {
        items: [
          {
            id: "input-interrupted",
            runId: "queued-input",
            acceptedAt: 1,
            state: "interrupted",
            message: message("user", "Open a PR to fix it"),
          },
        ],
        total: 1,
      },
    });
  await loadChatHistory(state);
  expect(state.chatRunId).toBe("run-interrupted");
  await loadChatHistory(state);
  expect(state).toMatchObject({ chatRunId: null, chatStream: null });
});

it("recovers a failure missed before the initial route subscription", async () => {
  const history = failedHistory();
  const state = createState(history);
  vi.spyOn(state.client!, "request").mockResolvedValue(history);
  state.chatSubmissions = createChatSubmissions();
  state.chatSubmissions.retain(
    buildInitialChatSubmission(
      state.sessionKey,
      { text: "Inspect the unavailable project", createdAt: 1 },
      state.client!,
      "run-first",
    ),
  );
  admitChatSubmission(state, undefined);
  await loadChatHistory(state, { startup: true });
  expect(state.chatRunError?.summary).toContain(history.sessionInfo!.lastRunError);
  expect(state.chatRunId).toBeNull();
  expect(state.chatMessages).toEqual(history.messages);
});

it("restores cleared activity alongside an owned run's current text", async () => {
  const history = activeHistory("run-live");
  history.inFlightRun!.text = "The active response survived reconnect.";
  history.inFlightRun!.events = [toolEvent("call-reconnected")];
  const state = createState(history);
  state.chatRunId = "run-live";
  state.chatStream = "The active response survived reconnect.";
  await loadWithTools(state);
  expect(state).toMatchObject({
    chatRunId: "run-live",
    chatStream: "The active response survived reconnect.",
    chatStreamSegments: [],
  });
  const continued = "The active response survived reconnect. Still streaming.";
  assistant(state, "run-live", continued);
  expect(renderedText(state)).toContain(continued);
  expect(renderedText(state)).not.toContain("The active response survived reconnect.");
  expect(state.chatToolMessages[0]).toMatchObject({
    runId: "run-live",
    toolCallId: "call-reconnected",
  });
});

it("keeps an identical new reply after the Gateway retires its persisted predecessor", () => {
  const state = createState(activeHistory("active-run"));
  state.chatMessages = [
    message("user", "Original prompt", { idempotencyKey: "active-run:user", seq: 1 }),
  ];
  assistant(state, "active-run", "Saved opening.");
  assistant(state, "active-run", "", { replace: true, deltaText: "" });
  publish(state, "active-run", {
    runId: "active-run",
    messageId: "saved",
    messageSeq: 2,
    message: message("assistant", "Saved opening.", {
      id: "saved",
      idempotencyKey: "active-run",
      seq: 2,
    }),
  });
  assistant(state, "active-run", "Saved opening.", { deltaText: "Saved opening." });
  expect(renderedText(state)).toEqual(["Original prompt", "Saved opening.", "Saved opening."]);
});

it("keeps an identical unpersisted tail through active history reload", async () => {
  const history = activeHistory("active-run");
  const prompt = message("user", "Repeat the answer", {
    id: "prompt",
    seq: 1,
    idempotencyKey: "active-run:user",
  });
  const { steer } = steerPrompts(3, 0);
  history.messages = [
    prompt,
    message("assistant", "Repeated answer.", { id: "saved", seq: 2, runId: "active-run" }),
    steer,
    message("user", "Queued follow-up.", { idempotencyKey: "queued-run:user", seq: 4 }),
  ];
  history.inFlightRun!.text = "Repeated answer.";
  const state = createState(history);
  state.chatMessages = [prompt];
  state.chatRunId = "active-run";
  assistant(state, "active-run", "Repeated answer.");
  publish(state, "active-run", {
    clientRunId: "active-run",
    messageId: "steer",
    messageSeq: 3,
    message: steer,
  });
  expect(renderedText(state)).toEqual(["Repeat the answer", "Steer prompt", "Repeated answer."]);
  await loadChatHistory(state);
  expect(state.chatRunId).toBe("active-run");
  const afterSteer = (text: string) => [
    "Repeat the answer",
    "Repeated answer.",
    "Steer prompt",
    text,
    "Queued follow-up.",
  ];
  expect(renderedText(state)).toEqual(afterSteer("Repeated answer."));
  assistant(state, "active-run", "Repeated answer. Continued.", { deltaText: " Continued." });
  expect(renderedText(state)).toEqual(afterSteer("Repeated answer. Continued."));
  emit(state, "active-run", {
    state: "final",
    message: {
      ...message("assistant", "Repeated answer. Repeated answer. Continued. Final."),
      openclawDisplayContent: [{ type: "text", text: "Repeated answer. Continued. Final." }],
    },
  });
  expect(renderedText(state)).toEqual(afterSteer("Repeated answer. Continued. Final."));
  expect(state.chatMessages.map(extractText)).toEqual(
    afterSteer("Repeated answer. Continued. Final."),
  );
  reduceChatSessionProjection(
    state,
    {
      type: "messagePersisted",
      message: message("user", "Later authoritative user.", {
        id: "later",
        seq: 5,
        idempotencyKey: "later:user",
      }),
      envelope: { messageId: "later", messageSeq: 5 },
    },
    { scope: readChatSessionProjectionScope(state), runActive: false },
  );
  expect(state.chatMessages.map(extractText)).toEqual([
    ...afterSteer("Repeated answer. Continued. Final."),
    "Later authoritative user.",
  ]);
});

it("preserves independent unkeyed preamble occurrences through steer then history", async () => {
  const runId = "active-run";
  const text = "Checking the workspace.";
  const now = Date.now();
  const prompt = message(
    "user",
    "Check the workspace",
    {
      id: "prompt",
      seq: 1,
      idempotencyKey: `${runId}:user`,
    },
    now - 3,
  );
  const history = activeHistory(runId);
  history.messages = [prompt];
  history.inFlightRun!.text = text;
  history.inFlightRun!.startedAt = now + 2;
  const state = createState(history);
  state.chatRunId = runId;
  state.chatMessages = [prompt];
  for (const seq of [1, 2, 2]) {
    handleAgentEvent(state, {
      sessionKey: "main",
      runId,
      seq,
      ts: now - 3 + seq,
      stream: "item",
      data: { kind: "preamble", phase: "end", progressText: text },
    });
  }
  const expected = ["Check the workspace", text, text];
  assistant(state, runId, "Before steer.");
  const { steer } = steerPrompts(3, now + 1);
  history.messages.push(
    message("assistant", "Before steer.", { id: "before", seq: 2, runId }, now),
    steer,
  );
  publish(state, runId, { clientRunId: runId, messageId: "steer", messageSeq: 3, message: steer });
  expected.push("Before steer.");
  await loadChatHistory(state);
  expect(state.chatRunId).toBe(runId);
  expect(renderedText(state)).toEqual([...expected, "Steer prompt", text]);
});

it("restores a newer live answer after a missed Gateway replacement", async () => {
  const newer = "Live next answer.";
  const runId = "active-run";
  const history = activeHistory(runId);
  const prompt = message("user", "Continue working", { id: "prompt", seq: 1, runId });
  history.messages = [prompt, message("assistant", "Saved reply.", { id: "saved", seq: 2, runId })];
  const { state, response, request } = delayed(history);
  state.chatMessages = [prompt];
  state.chatRunId = runId;
  assistant(state, runId, "Saved reply.", { seq: 1 });
  const loading = loadChatHistory(state);
  expect(request).toHaveBeenCalledOnce();
  assistant(state, runId, newer, { seq: 2, replace: true, deltaText: newer });
  response.resolve(history);
  await loading;
  expect(state.chatRunId).toBe(runId);
  expect(tail(state)).toBe(newer);
  expect(renderedText(state)).toEqual(["Continue working", "Saved reply.", newer]);
});

it("keeps a shorter live replacement over pending history and continues its baseline", async () => {
  const runId = "active-run";
  const history = activeHistory(runId);
  history.inFlightRun!.text = "Same.\n\nSame.";
  const { state, response, request } = delayed(history);
  assistant(state, runId, "Same.\n\nSame.", { seq: 1 });
  const loading = loadChatHistory(state);
  expect(request).toHaveBeenCalledOnce();
  assistant(state, runId, "Same.", { seq: 2, replace: true, deltaText: "Same." });
  response.resolve(history);
  await loading;
  expect(tail(state)).toBe("Same.");
  expect(renderedText(state)).toEqual(["Same."]);
  assistant(state, runId, "Same. More.", { seq: 3, deltaText: " More." });
  expect(tail(state)).toBe("Same. More.");
  expect(renderedText(state)).toEqual(["Same. More."]);
});

it("keeps the ordered live baseline while a longer snapshot is pending", async () => {
  const expected = "Buffered before reconnect.";
  const history = activeHistory("run-reconnected");
  history.messages = [message("user", "Continue working."), message("assistant", "Saved opening.")];
  history.inFlightRun!.text = "Buffered before reconnect. And live.";
  const { state, response, request } = delayed(history);
  const loading = loadChatHistory(state);
  expect(request).toHaveBeenCalledOnce();
  assistant(state, "run-reconnected", expected, { deltaText: " Buffered before reconnect." });
  response.resolve(history);
  await loading;
  expect(state).toMatchObject({ chatRunId: "run-reconnected", chatStream: expected });
  expect(tail(state)).toBe(expected);
  expect(state.chatMessages).toEqual(history.messages);
  assistant(state, "run-reconnected", `${expected} More.`, { deltaText: " More." });
  expect(state.chatStream).toBe(`${expected} More.`);
});

it("does not resurrect delayed history after a newer intervening run completes", async () => {
  const history = activeHistory("run-reconnected");
  history.sessionInfo!.activeRunIds = undefined;
  const { state, response, request } = delayed(history);
  const loading = loadChatHistory(state);
  expect(request).toHaveBeenCalledOnce();
  emit(state, "run-newer", {
    state: "delta",
    deltaText: "A response completed while history was pending.",
  });
  assistant(state, "run-newer", "The intervening run completed.", { state: "final" });
  expect(state.chatRunId).toBeNull();
  response.resolve(history);
  await loading;
  expect(state).toMatchObject({ chatRunId: null, chatStream: null });
});

it("retains newer live startup progress through delayed history", async () => {
  const history = activeHistory("run-live");
  history.inFlightRun!.events = [event(2, "run_status", { phase: "naming_worktree" })];
  const { state, response, request } = delayed(history);
  state.chatRunId = "run-live";
  const loading = loadChatHistory(state);
  expect(request).toHaveBeenCalledOnce();
  emit(state, "run-live", { seq: 3, state: "status", phase: "creating_worktree" });
  response.resolve(history);
  await loading;
  expect(state.chatRunStartup).toMatchObject({
    state: "status",
    runId: "run-live",
    phase: "creating_worktree",
  });
});

describe("chat history run ownership recovery", () => {
  it("retires a stale run from a fresh idle delta after another run completed", async () => {
    const initial = activeHistory("run-missed-terminal");
    initial.sessionInfo!.sessionId = "same-session";
    initial.deltaCursor = "before-completion";
    const sessionInfo = {
      ...initial.sessionInfo!,
      hasActiveRun: false,
      activeRunIds: [],
      lastRunId: "run-completed-later",
      status: "done" as const,
    };
    const completed: ChatHistoryResponse = {
      kind: "delta",
      messages: [],
      sessionInfo,
      deltaCursor: "after-completion",
    };
    const request = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(completed);
    const state = createState(initial);
    state.client = { request } as unknown as GatewayBrowserClient;
    await loadChatHistory(state);
    expect(state.chatRunId).toBe("run-missed-terminal");
    state.chatMessage = "An unsent draft";

    await loadChatHistory(state);

    expect(state).toMatchObject({
      chatRunId: null,
      chatStream: null,
      chatStreamStartedAt: null,
      chatRunStatus: null,
      chatMessage: "An unsent draft",
    });
  });

  it("recovers stale Stop ownership from a fresh delta without aborting the replacement run", async () => {
    const initial = activeHistory("run-missed-terminal");
    initial.sessionInfo!.sessionId = "same-session";
    initial.inFlightRun!.text = "The old response.";
    initial.deltaCursor = "before-replacement";
    const replacement = activeHistory("run-current");
    replacement.sessionInfo!.sessionId = "same-session";
    replacement.sessionInfo!.lastRunId = "run-current";
    replacement.inFlightRun!.text = "The current response.";
    const recovered: ChatHistoryResponse = {
      ...replacement,
      kind: "delta",
      messages: [],
      sessionInfo: replacement.sessionInfo!,
      deltaCursor: "after-replacement",
    };
    let response: ChatHistoryResponse = initial;
    const request = vi.fn((method: string) => {
      if (method === "chat.abort") {
        return Promise.resolve({ aborted: false });
      }
      if (method === "chat.history") {
        return Promise.resolve(response);
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const abortCalls = () => request.mock.calls.filter(([method]) => method.endsWith(".abort"));
    const state = Object.assign(createState(initial), {
      chatLocalInputHistoryBySession: {},
      chatInputHistorySessionKey: null,
      chatInputHistoryItems: null,
      chatInputHistoryIndex: -1,
      chatDraftBeforeHistory: null,
      refreshCurrentChat: async () => {
        await loadChatHistory(state);
      },
    });
    state.client = { request } as unknown as GatewayBrowserClient;
    await loadChatHistory(state);
    expect(state.chatRunId).toBe("run-missed-terminal");
    response = recovered;

    await handleAbortChat(state, { preserveDraft: true });

    expect(abortCalls()).toEqual([
      ["chat.abort", { sessionKey: "main", runId: "run-missed-terminal" }],
    ]);
    expect(state.chatRunId).toBe("run-current");
    expect(state.chatStream).toBe("The current response.");
    assistant(state, "run-current", "The current response. Continued.");
    expect(state.chatStream).toBe("The current response. Continued.");

    await handleAbortChat(state, { preserveDraft: true });

    expect(abortCalls()).toEqual([
      ["chat.abort", { sessionKey: "main", runId: "run-missed-terminal" }],
      ["chat.abort", { sessionKey: "main", runId: "run-current" }],
    ]);
  });

  it.each([
    "replacement session",
    "live delta",
    "lifecycle restart",
    "pending send",
    "late consumer",
  ])("retains local ownership across %s during idle history", async (change) => {
    const history = activeHistory("run-history");
    history.sessionInfo!.sessionId = "same-session";
    delete history.inFlightRun;
    Object.assign(history.sessionInfo!, {
      hasActiveRun: false,
      activeRunIds: [],
      lastRunId: "run-history",
      status: "done",
    });
    if (change === "replacement session") {
      history.sessionInfo!.sessionId = "different-session";
    }
    const { state, request, response: pending } = delayed(history);
    state.currentSessionId = "same-session";
    adoptStartedChatRun(state, "run-owned", 1);
    const snapshotOnly = change === "replacement session";
    if (snapshotOnly) {
      state.chatStream = "Still locally owned.";
    }
    const first = change === "late consumer" ? createState(history) : state;
    if (first !== state) {
      first.client = state.client;
      first.sessions = state.sessions;
      first.currentSessionId = "same-session";
      adoptStartedChatRun(first, "run-owned", 1);
    }
    const firstLoad = first !== state ? loadChatHistory(first) : undefined;
    const loading = loadChatHistory(state);
    expect(request).toHaveBeenCalledOnce();
    if (change === "lifecycle restart") {
      reconcileChatRunLifecycle(state, { clearLocalRun: true, publishRunState: false });
      adoptStartedChatRun(state, "run-owned", 2);
    } else if (change === "pending send") {
      state.chatQueue.push({
        id: "pending",
        text: "Newer request",
        createdAt: 2,
        sendState: "sending",
        sendRunId: "run-pending",
      });
    } else if (change === "live delta") {
      assistant(state, "run-owned", "Newer live response.");
    }
    const stream = state.chatStream;
    pending.resolve(history);
    await Promise.all([firstLoad, loading]);

    expect(state.chatRunId).toBe("run-owned");
    expect(state.chatStream).toBe(snapshotOnly ? "Still locally owned." : stream);
    if (first !== state) {
      expect(first.chatRunId).toBeNull();
    }
  });
});
