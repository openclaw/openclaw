// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
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

async function loadWithTools(state: TestState) {
  vi.stubGlobal("window", globalThis);
  try {
    await loadChatHistory(state);
    await vi.waitFor(() => expect(state.chatToolMessages).toHaveLength(1));
  } finally {
    vi.unstubAllGlobals();
  }
}

it("restores a later model wait alongside earlier response text", async () => {
  const history = activeHistory("run-live");
  history.inFlightRun!.text = "First result.";
  history.inFlightRun!.events = [
    event(3, "run_status", {
      phase: "waiting_for_model",
      reason: "slot",
    }),
  ];
  const state = createState(history);
  await loadChatHistory(state);
  expect(state.chatRunStartup).toMatchObject({
    state: "status",
    runId: "run-live",
    phase: "waiting_for_model",
    waitReason: "slot",
    seq: 3,
  });
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
  expect(state.chatRunId).toBeNull();
  expect(state.chatStream).toBeNull();
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

it("restores tools, preamble time, and usage from the active snapshot", async () => {
  const history = activeHistory("run-live");
  history.inFlightRun!.events = [
    {
      runId: "run-live",
      seq: 1,
      stream: "item",
      ts: 900,
      sessionKey: "main",
      data: {
        kind: "preamble",
        itemId: "preamble-restored",
        progressText: "Checking the workspace",
      },
    },
    toolEvent("call-restored"),
    {
      runId: "run-live",
      seq: 3,
      stream: "usage",
      ts: 1100,
      sessionKey: "main",
      data: { outputTokens: 695, context: { totalTokens: 1500, contextWindow: 8000 } },
    },
  ];
  const state = createState(history);
  await loadWithTools(state);
  expect(state.chatRunUsageById?.get("run-live")?.outputTokens).toBe(695);
  expect(state.chatToolMessages[0]).toMatchObject({
    runId: "run-live",
    toolCallId: "call-restored",
    content: [expect.objectContaining({ type: "toolcall", name: "read" })],
  });
  expect(state.chatStreamSegments).toContainEqual(
    expect.objectContaining({
      itemId: "preamble-restored",
      runId: "run-live",
      text: "Checking the workspace",
      ts: 900,
    }),
  );
});

it("restores cleared activity alongside an owned run's current text", async () => {
  const history = activeHistory("run-live");
  history.inFlightRun!.text = "The active response survived reconnect.";
  history.inFlightRun!.events = [toolEvent("call-reconnected")];
  const state = createState(history);
  state.chatRunId = "run-live";
  state.chatStream = "The active response survived reconnect.";
  await loadWithTools(state);
  expect(state.chatRunId).toBe("run-live");
  expect(state.chatStream).toBe("The active response survived reconnect.");
  expect(state.chatStreamSegments).toEqual([]);
  const continued = "The active response survived reconnect. Still streaming.";
  emit(state, "run-live", { state: "delta", message: message("assistant", continued) });
  expect(renderedText(state)).toContain(continued);
  expect(renderedText(state)).not.toContain("The active response survived reconnect.");
  expect(state.chatToolMessages[0]).toMatchObject({
    runId: "run-live",
    toolCallId: "call-reconnected",
  });
});

it.each(["fresh mirror"])(
  "keeps saved replies before an accepted steer and the live tail after it (%s)",
  async () => {
    const history = activeHistory("active-run");
    const identity = (seq: number) => ({
      runId: "active-run",
      mirrorIdentity: `turn-1:assistant:answer-${seq}`,
      seq,
    });
    const { original, steer } = steerPrompts(5);
    const prefix = "Before tool.Before steer.";
    history.messages = [
      original,
      message("assistant", "Before tool.", identity(2), 2),
      {
        ...message(
          "assistant",
          "Checking the result.",
          { idempotencyKey: "active-run", seq: 3 },
          3,
        ),
        openclawStreamFallback: {
          itemId: "commentary-item",
          source: "segment",
          replacementText: "Checking the result.",
          runId: "active-run",
        },
      },
      message("assistant", "Before steer.", identity(4), 4),
      steer,
      message("user", "Queued follow-up.", { idempotencyKey: "queued-run:user", seq: 6 }),
    ];
    history.inFlightRun!.text = "After steer.";
    const persistedText = history.messages.slice(0, -2).map(extractText);
    const state = createState(history);
    await loadChatHistory(state);
    expect(tail(state)).toBe("After steer.");
    expect(renderedText(state)).toEqual([
      ...persistedText,
      "Steer prompt",
      "After steer.",
      "Queued follow-up.",
    ]);
    emit(state, "active-run", {
      state: "delta",
      deltaText: " Continued.",
      message: message("assistant", "After steer. Continued."),
    });
    expect(renderedText(state)).toEqual([
      ...persistedText,
      "Steer prompt",
      "After steer. Continued.",
      "Queued follow-up.",
    ]);
    expect(state.chatStream).toBe("After steer. Continued.");
    emit(state, "active-run", {
      state: "final",
      message: {
        ...message("assistant", `${prefix} After steer. Continued. Final suffix.`),
        openclawDisplayContent: [{ type: "text", text: "After steer. Continued. Final suffix." }],
      },
    });
    const expected = [
      ...persistedText,
      "Steer prompt",
      "After steer. Continued. Final suffix.",
      "Queued follow-up.",
    ];
    expect(renderedText(state)).toEqual(expected);
    const transcriptOrder = [
      ...persistedText,
      "Steer prompt",
      "After steer. Continued. Final suffix.",
      "Queued follow-up.",
    ];
    expect(state.chatMessages.map(extractText)).toEqual(transcriptOrder);
    expect(state.chatMessages.at(-2)).toMatchObject({ role: "assistant" });
    reduceChatSessionProjection(
      state,
      {
        type: "messagePersisted",
        message: message("user", "Later authoritative user.", {
          id: "later",
          idempotencyKey: "later-run:user",
          seq: 7,
        }),
        envelope: { messageId: "later", messageSeq: 7 },
      },
      { scope: readChatSessionProjectionScope(state), runActive: false },
    );
    expect(state.chatMessages.map(extractText)).toEqual([
      ...transcriptOrder,
      "Later authoritative user.",
    ]);
  },
);

it.each([false])(
  "keeps the accepted steer before the whole unpersisted assistant message (history=%s)",
  async () => {
    const runId = "active-run";
    const { original, steer } = steerPrompts(2);
    const history = activeHistory(runId);
    history.messages = [original, steer];
    history.inFlightRun!.text = "Before steer. After steer.";
    const state = createState(history);
    state.chatMessages = [original];
    state.chatRunId = runId;
    emit(state, runId, {
      state: "delta",
      message: message("assistant", "Before steer."),
    });
    applySessionMessagePayload(
      state,
      { clientRunId: runId, messageId: "steer", messageSeq: 2, message: steer },
      true,
      { kind: "live", activeRunId: runId },
    );
    expect(renderedText(state)).toEqual(["Original prompt", "Steer prompt", "Before steer."]);
    emit(state, runId, {
      state: "delta",
      deltaText: " After steer.",
      message: message("assistant", "Before steer. After steer."),
    });
    expect(state.chatRunId).toBe(runId);
    expect(renderedText(state)).toEqual([
      "Original prompt",
      "Steer prompt",
      "Before steer. After steer.",
    ]);
  },
);

it("keeps streaming one message after a live steer is published", async () => {
  const history = activeHistory("active-run");
  const { original, steer } = steerPrompts(2, 3);
  history.messages = [original, steer];
  history.inFlightRun!.text = "Before steer.";
  const state = createState(history);
  state.chatMessages = [original];
  emit(state, "active-run", { state: "delta", message: message("assistant", "Before steer.") });
  await loadChatHistory(state);
  applySessionMessagePayload(state, { message: steer }, true, {
    kind: "live",
    activeRunId: "active-run",
  });
  emit(state, "active-run", {
    state: "delta",
    deltaText: " After steer.",
    message: message("assistant", "Before steer. After steer."),
  });
  expect(renderedText(state)).toEqual([
    "Original prompt",
    "Steer prompt",
    "Before steer. After steer.",
  ]);
});

it("keeps an identical new reply after the Gateway retires its persisted predecessor", () => {
  const state = createState(activeHistory("active-run"));
  state.chatMessages = [
    message("user", "Original prompt", { idempotencyKey: "active-run:user", seq: 1 }),
  ];
  emit(state, "active-run", { state: "delta", message: message("assistant", "Saved opening.") });
  emit(state, "active-run", {
    state: "delta",
    replace: true,
    deltaText: "",
    message: message("assistant", ""),
  });
  applySessionMessagePayload(
    state,
    {
      runId: "active-run",
      messageId: "saved",
      messageSeq: 2,
      message: message("assistant", "Saved opening.", {
        id: "saved",
        idempotencyKey: "active-run",
        seq: 2,
      }),
    },
    true,
    { kind: "live", activeRunId: "active-run" },
  );
  emit(state, "active-run", {
    state: "delta",
    deltaText: "Saved opening.",
    message: message("assistant", "Saved opening."),
  });
  expect(renderedText(state)).toEqual(["Original prompt", "Saved opening.", "Saved opening."]);
});

it.each([true])(
  "keeps an identical unpersisted tail through active history reload (retained steer=%s)",
  async () => {
    const history = activeHistory("active-run");
    const prompt = message("user", "Repeat the answer", {
      id: "prompt",
      seq: 1,
      idempotencyKey: "active-run:user",
    });
    const steer = message("user", "Steer prompt", {
      id: "steer",
      seq: 3,
      idempotencyKey: "steer-run:user",
      steerTargetRunId: "active-run",
    });
    history.messages = [
      prompt,
      message("assistant", "Repeated answer.", { id: "saved", seq: 2, runId: "active-run" }),
      steer,
    ];
    history.inFlightRun!.text = "Repeated answer.";
    const state = createState(history);
    state.chatMessages = [prompt];
    state.chatRunId = "active-run";
    emit(state, "active-run", {
      state: "delta",
      message: message("assistant", "Repeated answer."),
    });
    applySessionMessagePayload(
      state,
      {
        clientRunId: "active-run",
        messageId: "steer",
        messageSeq: 3,
        message: steer,
      },
      true,
      { kind: "live", activeRunId: "active-run" },
    );
    expect(renderedText(state)).toEqual(["Repeat the answer", "Steer prompt", "Repeated answer."]);
    await loadChatHistory(state);
    expect(state.chatRunId).toBe("active-run");
    const persisted = ["Repeat the answer", "Repeated answer."];
    const steers = ["Steer prompt"];
    expect(renderedText(state)).toEqual([...persisted, ...steers, "Repeated answer."]);
    emit(state, "active-run", {
      state: "delta",
      deltaText: " Continued.",
      message: message("assistant", "Repeated answer. Continued."),
    });
    expect(renderedText(state)).toEqual([...persisted, ...steers, "Repeated answer. Continued."]);
  },
);

it.each(["steer then history"])(
  "preserves independent unkeyed preamble occurrences through %s",
  async () => {
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
    emit(state, runId, { state: "delta", message: message("assistant", "Before steer.") });
    const steer = message(
      "user",
      "Steer prompt",
      {
        id: "steer",
        seq: 3,
        idempotencyKey: "steer-run:user",
        steerTargetRunId: runId,
      },
      now + 1,
    );
    history.messages.push(
      message("assistant", "Before steer.", { id: "before", seq: 2, runId }, now),
      steer,
    );
    applySessionMessagePayload(
      state,
      { clientRunId: runId, messageId: "steer", messageSeq: 3, message: steer },
      true,
      { kind: "live", activeRunId: runId },
    );
    expected.push("Before steer.");
    await loadChatHistory(state);
    expect(state.chatRunId).toBe(runId);
    expect(renderedText(state)).toEqual([...expected, "Steer prompt", text]);
  },
);

it.each([
  {
    name: "a newer live answer",
    snapshot: "",
    newer: "Live next answer.",
    expectedTail: "Live next answer.",
  },
])(
  "restores $name after a missed Gateway replacement",
  async ({ snapshot, newer, expectedTail }) => {
    const runId = "active-run";
    const history = activeHistory(runId);
    const prompt = message("user", "Continue working", { id: "prompt", seq: 1, runId });
    history.messages = [
      prompt,
      message("assistant", "Saved reply.", { id: "saved", seq: 2, runId }),
    ];
    history.inFlightRun!.text = snapshot;
    const { state, response, request } = delayed(history);
    state.chatMessages = [prompt];
    state.chatRunId = runId;
    emit(state, runId, { state: "delta", seq: 1, message: message("assistant", "Saved reply.") });
    const loading = loadChatHistory(state);
    expect(request).toHaveBeenCalledOnce();
    emit(state, runId, {
      state: "delta",
      seq: 2,
      replace: true,
      deltaText: newer,
      message: message("assistant", newer),
    });
    response.resolve(history);
    await loading;
    expect(state.chatRunId).toBe(runId);
    expect(tail(state)).toBe(expectedTail);
    expect(renderedText(state)).toEqual([
      "Continue working",
      "Saved reply.",
      ...(expectedTail ? [expectedTail] : []),
    ]);
  },
);

it("keeps a shorter live replacement over pending history and continues its baseline", async () => {
  const runId = "active-run";
  const history = activeHistory(runId);
  history.inFlightRun!.text = "Same.\n\nSame.";
  const { state, response, request } = delayed(history);
  emit(state, runId, {
    state: "delta",
    seq: 1,
    message: message("assistant", "Same.\n\nSame."),
  });
  const loading = loadChatHistory(state);
  expect(request).toHaveBeenCalledOnce();
  emit(state, runId, {
    state: "delta",
    seq: 2,
    replace: true,
    deltaText: "Same.",
    message: message("assistant", "Same."),
  });
  response.resolve(history);
  await loading;
  expect(tail(state)).toBe("Same.");
  expect(renderedText(state)).toEqual(["Same."]);
  emit(state, runId, {
    state: "delta",
    seq: 3,
    deltaText: " More.",
    message: message("assistant", "Same. More."),
  });
  expect(tail(state)).toBe("Same. More.");
  expect(renderedText(state)).toEqual(["Same. More."]);
});

it.each([
  {
    snapshot: "Buffered before reconnect. And live.",
    delta: " Buffered before reconnect.",
    live: "Buffered before reconnect.",
    expected: "Buffered before reconnect.",
  },
])(
  "keeps the ordered live baseline while snapshot $snapshot is pending",
  async ({ snapshot, delta, live, expected }) => {
    const history = activeHistory("run-reconnected");
    history.messages = [
      message("user", "Continue working."),
      message("assistant", "Saved opening."),
    ];
    history.inFlightRun!.text = snapshot;
    const { state, response, request } = delayed(history);
    const loading = loadChatHistory(state);
    expect(request).toHaveBeenCalledOnce();
    emit(state, "run-reconnected", {
      state: "delta",
      deltaText: delta,
      message: message("assistant", live),
    });
    response.resolve(history);
    await loading;
    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe(expected);
    expect(tail(state)).toBe(expected);
    expect(state.chatMessages).toEqual(history.messages);
    emit(state, "run-reconnected", {
      state: "delta",
      deltaText: " More.",
      message: message("assistant", `${expected} More.`),
    });
    expect(state.chatStream).toBe(`${expected} More.`);
  },
);

it("does not resurrect delayed history after a newer intervening run completes", async () => {
  const history = activeHistory("run-reconnected");
  history.sessionInfo = {
    ...history.sessionInfo,
    key: "main",
    kind: "direct",
    activeRunIds: undefined,
    activeModel: "old-fallback",
    activeModelProvider: "example",
  };
  const { state, response, request } = delayed(history);
  const loading = loadChatHistory(state);
  expect(request).toHaveBeenCalledOnce();
  emit(state, "run-newer", {
    state: "delta",
    deltaText: "A response completed while history was pending.",
  });
  emit(state, "run-newer", {
    state: "final",
    message: message("assistant", "The intervening run completed."),
  });
  expect(state.chatRunId).toBeNull();
  response.resolve(history);
  await loading;
  expect(state.chatRunId).toBeNull();
  expect(state.chatStream).toBeNull();
});

it("retains newer live startup progress through delayed history", async () => {
  const history = activeHistory("run-live");
  history.inFlightRun!.events = [event(2, "run_status", { phase: "naming_worktree" })];
  const { state, response, request } = delayed(history);
  state.chatRunId = "run-live";
  const loading = loadChatHistory(state);
  expect(request).toHaveBeenCalledOnce();
  handleChatGatewayEvent(state, {
    runId: "run-live",
    sessionKey: "main",
    seq: 3,
    state: "status",
    phase: "creating_worktree",
  });
  response.resolve(history);
  await loading;
  expect(state.chatRunStartup).toMatchObject({
    state: "status",
    runId: "run-live",
    phase: "creating_worktree",
  });
});

describe("chat history run ownership recovery", () => {
  it.each(["delta"] as const)(
    "retires a stale run from a fresh idle %s after another run completed",
    async () => {
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

      expect(state.chatRunId).toBeNull();
      expect(state.chatStream).toBeNull();
      expect(state.chatStreamStartedAt).toBeNull();
      expect(state).toMatchObject({ chatRunStatus: null });
      expect(state.chatMessage).toBe("An unsent draft");
    },
  );

  it.each(["delta"] as const)(
    "recovers stale Stop ownership from a fresh %s without aborting the replacement run",
    async () => {
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
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "run-current",
        state: "delta",
        message: { role: "assistant", content: "The current response. Continued." },
      });
      expect(state.chatStream).toBe("The current response. Continued.");

      await handleAbortChat(state, { preserveDraft: true });

      expect(abortCalls()).toEqual([
        ["chat.abort", { sessionKey: "main", runId: "run-missed-terminal" }],
        ["chat.abort", { sessionKey: "main", runId: "run-current" }],
      ]);
    },
  );

  it.each([
    { change: "replacement session", idle: true },
    { change: "live delta", idle: true },
    { change: "lifecycle restart", idle: true },
    { change: "pending send", idle: true },
    { change: "late consumer", idle: true },
  ])("retains local ownership across $change (idle history: $idle)", async ({ change }) => {
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
    const pending = createDeferred<ChatHistoryResult>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const state = createState(history);
    state.client = { request } as unknown as GatewayBrowserClient;
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
      reconcileChatRunLifecycle(state, { clearLocalRun: true, requestUpdate: false });
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
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "run-owned",
        state: "delta",
        message: { role: "assistant", content: "Newer live response." },
      });
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

describe("chat history state contention", () => {
  it("restores a quiet state contention wait without a provider retry or a new run", async () => {
    const history = activeHistory("run-1");
    history.inFlightRun = {
      runId: "run-1",
      text: "",
      events: [
        {
          runId: "run-1",
          seq: 2,
          stream: "run_status",
          ts: 1,
          data: { phase: "waiting_for_state" },
        },
      ],
    };
    const state = createState(history);
    state.chatMessage = "Unsent draft";
    if (!state.client) {
      throw new Error("Expected the history fixture client");
    }
    const request = vi.spyOn(state.client, "request");
    await loadChatHistory(state);
    expect(state.chatRunStartup).toEqual({
      state: "status",
      runId: "run-1",
      seq: 2,
      phase: "waiting_for_state",
    });
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatRunError).toBeFalsy();
    expect(state.chatMessage).toBe("Unsent draft");
    expect(request.mock.calls.some(([method]) => method === "chat.history")).toBe(true);
    expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });
});
