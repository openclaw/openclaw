// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import type { ChatHistoryResponse, ChatHistoryResult } from "./chat-history-snapshot.ts";
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

function activeSnapshot(
  runId = "active-run",
  text = "",
  messages: ChatHistoryResult["messages"] = [],
) {
  const result = activeHistory(runId);
  result.inFlightRun!.text = text;
  result.messages = messages;
  return result;
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
  const snapshot = activeSnapshot("run-live", "Restored.");
  snapshot.inFlightRun!.events = [toolEvent("call-reconnected")];
  const state = createState(snapshot);
  state.chatRunId = "run-live";
  state.chatStream = "Restored.";
  await loadWithTools(state);
  expect(state).toMatchObject({
    chatRunId: "run-live",
    chatStream: "Restored.",
    chatStreamSegments: [],
  });
  const continued = "Restored. Still streaming.";
  assistant(state, "run-live", continued);
  expect(renderedText(state)).toContain(continued);
  expect(renderedText(state)).not.toContain("Restored.");
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
  const prompt = message("user", "Repeat", {
    id: "prompt",
    seq: 1,
    idempotencyKey: "active-run:user",
  });
  const { steer } = steerPrompts(3, 0);
  history.messages = [
    prompt,
    message("assistant", "Answer.", { id: "saved", seq: 2, runId: "active-run" }),
    steer,
    message("user", "Queued.", { idempotencyKey: "queued-run:user", seq: 4 }),
  ];
  history.inFlightRun!.text = "Answer.";
  const state = createState(history);
  state.chatMessages = [prompt];
  state.chatRunId = "active-run";
  assistant(state, "active-run", "Answer.");
  publish(state, "active-run", {
    clientRunId: "active-run",
    messageId: "steer",
    messageSeq: 3,
    message: steer,
  });
  expect(renderedText(state)).toEqual(["Repeat", "Steer prompt", "Answer."]);
  await loadChatHistory(state);
  expect(state.chatRunId).toBe("active-run");
  const afterSteer = (text: string) => ["Repeat", "Answer.", "Steer prompt", text, "Queued."];
  expect(renderedText(state)).toEqual(afterSteer("Answer."));
  assistant(state, "active-run", "Answer. Continued.", { deltaText: " Continued." });
  expect(renderedText(state)).toEqual(afterSteer("Answer. Continued."));
  emit(state, "active-run", {
    state: "final",
    message: {
      ...message("assistant", "Answer. Answer. Continued. Final."),
      openclawDisplayContent: [{ type: "text", text: "Answer. Continued. Final." }],
    },
  });
  expect(renderedText(state)).toEqual(afterSteer("Answer. Continued. Final."));
  expect(state.chatMessages.map(extractText)).toEqual(afterSteer("Answer. Continued. Final."));
  reduceChatSessionProjection(
    state,
    {
      type: "messagePersisted",
      message: message("user", "Later", {
        id: "later",
        seq: 5,
        idempotencyKey: "later:user",
      }),
      envelope: { messageId: "later", messageSeq: 5 },
    },
    { scope: readChatSessionProjectionScope(state), runActive: false },
  );
  expect(state.chatMessages.map(extractText)).toEqual([
    ...afterSteer("Answer. Continued. Final."),
    "Later",
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

it.each([
  ["missed replacement", "", "Saved.", "New.", true],
  ["shorter replacement", "Same.\n\nSame.", "Same.\n\nSame.", "Same.", true],
  ["ordered live baseline", "Buffered. And live.", undefined, "Buffered.", false],
] as const)("preserves %s over pending history", async (kind, snapshot, initial, live, replace) => {
  const runId = "active-run";
  const prefix = kind === "shorter replacement" ? [] : ["Continue", "Saved."];
  const persisted =
    kind === "shorter replacement"
      ? []
      : kind === "ordered live baseline"
        ? [message("user", "Continue"), message("assistant", "Saved.")]
        : [
            message("user", "Continue", { id: "prompt", seq: 1, runId }),
            message("assistant", "Saved.", { id: "saved", seq: 2, runId }),
          ];
  const result = activeSnapshot(runId, snapshot, persisted);
  const { state, response } = delayed(result);
  if (kind === "missed replacement") {
    state.chatMessages = persisted.slice(0, 1);
    state.chatRunId = runId;
  }
  if (initial !== undefined) {
    assistant(state, runId, initial, { seq: 1 });
  }
  const loading = loadChatHistory(state);
  assistant(
    state,
    runId,
    live,
    replace ? { seq: 2, replace, deltaText: live } : { deltaText: ` ${live}` },
  );
  response.resolve(result);
  await loading;
  expect(state.chatRunId).toBe(runId);
  expect(state.chatMessages).toEqual(persisted);
  expect(tail(state)).toBe(live);
  expect(renderedText(state)).toEqual([...prefix, live]);
  assistant(state, runId, `${live} More.`, { seq: 3, deltaText: " More." });
  expect(state.chatStream).toBe(`${live} More.`);
  expect(tail(state)).toBe(`${live} More.`);
  expect(renderedText(state)).toEqual([...prefix, `${live} More.`]);
});

it("does not resurrect delayed history after a newer intervening run completes", async () => {
  const history = activeHistory("run-reconnected");
  history.sessionInfo!.activeRunIds = undefined;
  const { state, response } = delayed(history);
  const loading = loadChatHistory(state);
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
  const { state, response } = delayed(history);
  state.chatRunId = "run-live";
  const loading = loadChatHistory(state);
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
