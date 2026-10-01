// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  updateChatRunProgressSnapshot,
  type ChatRunProgressSnapshot,
} from "../../../../src/gateway/server-chat-progress-snapshot.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { isHiddenAssistantStreamText } from "../../lib/chat/message-visibility.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { materializeVisibleAssistantStreamMessages } from "./chat-history-stream.ts";
import {
  activeHistory,
  createState,
  type TestState,
} from "./chat-history.inflight.test-support.ts";
import { loadChatHistory, type ChatEventPayload } from "./chat-history.ts";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import {
  admitChatSubmission,
  getChatSessionProjection,
  getChatModelObservedRunId,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
  publishChatSessionProjection,
} from "./history-merge.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { visibleCurrentAssistantStreamTail } from "./stream-reconciliation.ts";
import { handleAgentEvent } from "./tool-stream.ts";
import { buildInitialChatSubmission } from "./user-message-content.ts";

const message = (
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  timestamp?: number,
) => ({
  role,
  content,
  ...(metadata ? { __openclaw: metadata } : {}),
  ...(timestamp ? { timestamp } : {}),
});
function emit(
  state: TestState,
  runId: string,
  event: Omit<ChatEventPayload, "sessionKey" | "runId">,
) {
  handleChatGatewayEvent(state, { sessionKey: "main", runId, ...event });
}
function delayed(history: ChatHistoryResult) {
  const response = createDeferred<ChatHistoryResult>();
  const state = createState(history);
  const request = vi.spyOn(state.client!, "request").mockReturnValue(response.promise);
  return { state, response, request };
}
const tail = (state: TestState) =>
  visibleCurrentAssistantStreamTail(state, isHiddenAssistantStreamText);
function renderedText(state: TestState) {
  return buildChatItems({
    paneId: "steer-regression",
    sessionKey: state.sessionKey,
    runId: state.chatRunId,
    messages: state.chatMessages,
    toolMessages: state.chatToolMessages,
    streamSegments: state.chatStreamSegments,
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    showToolCalls: true,
  }).flatMap((item) =>
    item.kind === "group"
      ? item.messages.map(({ message: entry }) => extractText(entry)?.trim())
      : item.kind === "stream"
        ? [item.text.trim()]
        : [],
  );
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
function failedHistory(): ChatHistoryResult {
  return {
    messages: [
      message(
        "user",
        "Inspect the unavailable project",
        { id: "first-user", idempotencyKey: "run-first:user", seq: 1 },
        1,
      ),
    ],
    sessionInfo: {
      key: "main",
      kind: "direct",
      updatedAt: 2,
      status: "failed",
      hasActiveRun: false,
      lastRunId: "run-first",
      lastRunError:
        "ProjectCloneError: Git clone could not reach GitHub. Check the Gateway network connection and retry.",
    },
  };
}
function steerPrompts(seq: number, timestamp = seq) {
  return {
    original: message("user", "Original prompt", { idempotencyKey: "active-run:user", seq: 1 }, 1),
    steer: message(
      "user",
      "Steer prompt",
      {
        id: "steer",
        idempotencyKey: "steer-run:user",
        seq,
        steerTargetRunId: "active-run",
      },
      timestamp,
    ),
  };
}
const toolEvent = (call: string) => ({
  ...event(2, "tool", {
    toolCallId: call,
    name: "read",
    phase: "start",
    args: { path: "README.md" },
  }),
  ts: 1000,
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

it("clears a recovered failure on retry and retains its full live error", async () => {
  const history = failedHistory();
  const state = createState(history);
  const request = vi
    .spyOn(state.client!, "request")
    .mockResolvedValueOnce(history)
    .mockResolvedValueOnce(activeHistory("run-retry"));
  await loadChatHistory(state);
  expect(state.chatRunError?.summary).toContain(history.sessionInfo!.lastRunError);
  await loadChatHistory(state);
  expect(state.chatRunId).toBe("run-retry");
  expect(state.chatRunError).toBeNull();
  const fullError = "A more detailed live retry error. Check repository access and retry.";
  emit(state, "run-retry", { state: "error", errorMessage: fullError });
  request.mockResolvedValue({
    ...history,
    sessionInfo: {
      ...history.sessionInfo,
      lastRunId: "run-retry",
      lastRunError: "A more detailed live retry error.",
    },
  });
  await loadChatHistory(state);
  expect(state.chatRunError?.summary).toContain(fullError);
  expect(state.chatRunId).toBeNull();
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

it("restores cleared activity without replacing an owned run's live text", async () => {
  const history = activeHistory("run-live");
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

it.each(["fresh mirror", "retained idempotency"])(
  "keeps cumulative prefixes through history replacement (%s)",
  async (mode) => {
    const history = activeHistory("active-run");
    const identity = (seq: number) =>
      mode === "fresh mirror"
        ? { runId: "active-run", mirrorIdentity: `turn-1:assistant:answer-${seq}`, seq }
        : { idempotencyKey: "active-run", seq };
    const { original, steer } = steerPrompts(5);
    const prefix = "Before tool.Before steer.";
    history.messages = [
      original,
      message("assistant", "Before tool.", identity(2), 2),
      ...(mode === "fresh mirror"
        ? [
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
          ]
        : []),
      message("assistant", "Before steer.", identity(4), 4),
      steer,
      message("user", "Queued follow-up.", { idempotencyKey: "queued-run:user", seq: 6 }),
    ];
    history.inFlightRun!.text = `${prefix} After steer.`;
    const persistedText = history.messages.slice(0, -1).map(extractText);
    const state = createState(history);
    if (mode === "retained idempotency") {
      state.chatRunId = "active-run";
      state.chatMessages = [original, steer];
      emit(state, "active-run", {
        state: "delta",
        message: message("assistant", history.inFlightRun!.text),
      });
      state.chatStreamSegments = [
        { text: prefix, ts: 2, runId: "active-run", boundaryRunId: "steer-run" },
      ];
    }
    await loadChatHistory(state);
    expect(tail(state)).toBe("After steer.");
    expect(renderedText(state)).toEqual([...persistedText, "After steer.", "Queued follow-up."]);
    emit(state, "active-run", {
      state: "delta",
      deltaText: " Continued.",
      message: message("assistant", `${prefix} After steer. Continued.`),
    });
    expect(renderedText(state)).toEqual([
      ...persistedText,
      "After steer. Continued.",
      "Queued follow-up.",
    ]);
    expect(state.chatStream).toBe(`${prefix} After steer. Continued.`);
    emit(state, "active-run", {
      state: "final",
      message: message("assistant", `${prefix} After steer. Continued. Final suffix.`),
    });
    const expected = [
      ...persistedText,
      "After steer. Continued. Final suffix.",
      "Queued follow-up.",
    ];
    expect(renderedText(state)).toEqual(expected);
    expect(state.chatMessages.map(extractText)).toEqual(expected);
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
    expect(state.chatMessages.map(extractText)).toEqual([...expected, "Later authoritative user."]);
  },
);

it("rolls over a live steer after active-run publication", async () => {
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
    "Before steer.",
    "Steer prompt",
    "After steer.",
  ]);
});

it("retains the persisted replacement baseline for the next cumulative delta", () => {
  const state = createState(activeHistory("active-run"));
  state.chatMessages = [
    message("user", "Original prompt", { idempotencyKey: "active-run:user", seq: 1 }),
  ];
  emit(state, "active-run", { state: "delta", message: message("assistant", "Saved opening.") });
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
    deltaText: " Continued.",
    message: message("assistant", "Saved opening. Continued."),
  });
  expect(renderedText(state)).toEqual(["Original prompt", "Saved opening.", "Continued."]);
});

it("restores ownership without exposing a suppressed response", async () => {
  const history = activeHistory("run-reconnected");
  history.inFlightRun!.text = "NO_REPLY";
  const state = createState(history);
  await loadChatHistory(state);
  expect(state.chatRunId).toBe("run-reconnected");
  expect(state.chatStream).toBeNull();
});

it("adopts the snapshot after remount replaces an unchanged run map", async () => {
  const history = activeHistory("run-reconnected");
  history.sessionInfo = {
    ...history.sessionInfo!,
    activeRunIds: undefined,
    activeModel: "fallback",
    activeModelProvider: "example",
  };
  history.inFlightRun!.text = "The response survived navigation.";
  const { state, response, request } = delayed(history);
  const loading = loadChatHistory(state);
  expect(request).toHaveBeenCalledOnce();
  const projection = getChatSessionProjection(state);
  publishChatSessionProjection(state, { ...projection, runs: { ...projection.runs } });
  response.resolve(history);
  await loading;
  expect(state.chatRunId).toBe("run-reconnected");
  expect(getChatModelObservedRunId(state, history.sessionInfo)).toBe("run-reconnected");
  expect(state.chatStream).toBe(history.inFlightRun!.text);
});

it.each([
  {
    snapshot: "Saved opening. repeat",
    delta: "repeat",
    live: "Saved opening. repeatrepeat",
    expected: "repeatrepeat",
  },
  {
    snapshot: "Saved opening. Buffered before reconnect. And live.",
    delta: " Buffered before reconnect.",
    live: "Saved opening. Buffered before reconnect.",
    expected: "Buffered before reconnect. And live.",
  },
])(
  "reconciles an in-flight delta against snapshot $snapshot",
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
    expect(state.chatStream).toBe(`Saved opening. ${expected}`);
    expect(tail(state)).toBe(expected);
    expect(state.chatMessages).toEqual(history.messages);
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
  expect(getChatModelObservedRunId(state, history.sessionInfo)).toBeUndefined();
});

const event = (seq: number, stream: string, data: Record<string, unknown>) => ({
  runId: "run-live",
  seq,
  stream,
  ts: 899 + seq,
  sessionKey: "main",
  data,
});

it("restores workspace preparation before visible activity", async () => {
  const history = activeHistory("run-live");
  history.inFlightRun!.events = [event(1, "run_status", { phase: "preparing_workspace" })];
  const state = createState(history);
  await loadChatHistory(state);
  expect(state.chatRunStartup).toEqual({
    state: "status",
    runId: "run-live",
    phase: "preparing_workspace",
    seq: 1,
  });
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

it.each([true, false])("reconciles retry waits after progress (live=%s)", async (live) => {
  const history = activeHistory("run-live");
  history.inFlightRun!.text = "I finished the first step.";
  const retry = event(2, "run_status", {
    phase: "retrying",
    message: "Rate limited. Retrying in 4 seconds (attempt 3/8).",
  });
  history.inFlightRun!.events = [
    event(1, "tool", { phase: "result", toolCallId: "read-1", name: "read", result: "done" }),
    retry,
  ];
  const state = createState(history);
  const label = () =>
    chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null);
  const text = () =>
    materializeVisibleAssistantStreamMessages(state.chatMessages, state).map(extractText);
  await loadChatHistory(state);
  expect(label()).toBe(retry.data.message);
  expect(state.chatRunId).toBe("run-live");
  expect(text()).toEqual(["I finished the first step."]);
  await loadChatHistory(state);
  expect(label()).toBe(retry.data.message);
  expect(text()).toEqual(["I finished the first step."]);
  const progress = event(3, "assistant", { text: "Continuing" });
  if (live) {
    handleAgentEvent(state, progress);
  } else {
    const snapshot = history.inFlightRun!.events.reduce<ChatRunProgressSnapshot | undefined>(
      (current, item) => updateChatRunProgressSnapshot(current, item),
      undefined,
    );
    history.inFlightRun!.events = updateChatRunProgressSnapshot(snapshot, progress)!.events;
    history.inFlightRun!.text += " Continuing";
  }
  await loadChatHistory(state);
  expect(label()).toBeUndefined();
  handleAgentEvent(state, { ...retry, seq: 4 });
  await loadChatHistory(state);
  expect(label()).toBe(retry.data.message);
  handleChatGatewayEvent(state, {
    runId: "run-live",
    sessionKey: "main",
    state: "final",
    message: { role: "assistant", content: "Finished" },
  });
  expect(state.chatRunId).toBeNull();
  expect(label()).toBeUndefined();
});
