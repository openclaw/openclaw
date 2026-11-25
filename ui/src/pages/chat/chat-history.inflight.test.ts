// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { boundInFlightRunSnapshotForChatHistory } from "../../../../src/gateway/chat-history-budget.js";
import { projectInFlightRunSnapshot } from "../../../../src/gateway/chat-inflight-snapshot.js";
import { createChatRunState } from "../../../../src/gateway/server-chat-state.js";
import {
  projectAgentHistoryActivity,
  projectAgentToolActivity,
} from "../../../../src/infra/agent-activity-events.js";
import { jsonUtf8Bytes } from "../../../../src/infra/json-utf8-bytes.js";
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
import { applyChatCacheSnapshot } from "./session-message-cache.ts";
import { handleAgentEvent } from "./tool-stream.ts";
import { buildLocalUserMessage, buildInitialChatSubmission } from "./user-message-content.ts";

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
): ChatHistoryResult {
  return { ...activeHistory(runId), messages, inFlightRun: { runId, text } };
}

it.each([
  ["waiting_for_model", "First result.", "slot"],
  ["waiting_for_state", "", undefined],
] as const)("restores %s without a retry or a new run", async (phase, text, waitReason) => {
  const history = activeSnapshot("run-live", text);
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

const SWATCH_RUN = "run-live";
const SWATCH_OPENING = "Amber marks the first swatch.";
const SWATCH_SUFFIX = " The tool returned amber.";

function swatchRows(...texts: string[]) {
  const imported = (id: string, content: unknown[]) => ({
    role: "assistant",
    provider: "claude-cli",
    content,
    __openclaw: { id, importedFrom: "claude-cli", cliSessionId: "swatches", externalId: id },
  });
  return [
    message("user", "Read the swatches.", { id: "input", idempotencyKey: SWATCH_RUN + ":user" }),
    ...texts.flatMap((text, i) => [
      imported("text-" + i, [{ type: "text", text }]),
      imported("call-" + i, [{ type: "toolcall", id: "read-" + i, name: "read" }]),
    ]),
  ];
}

it.each(["full", "bounded", "without input"])(
  "restores both native tool boundaries on a %s page",
  async (page) => {
    const parts = [SWATCH_OPENING, "Cobalt marks the next swatch."];
    const runId = SWATCH_RUN;
    const chatRunState = createChatRunState();
    const buffer = (text: string) =>
      chatRunState.updateBuffer(runId, { itemId: "assistant", text });
    for (const [i] of parts.entries()) {
      buffer(parts.slice(0, i + 1).join("\n\n"));
      const start = toolEvent("read-" + i);
      start.seq += i;
      start.data.textLengthBeforeTool = chatRunState.resolveBuffer(runId).text.length;
      chatRunState.recordProgressEvent(runId, start);
    }
    const text = [...parts, "Final result."].join("\n\n");
    buffer(text);
    const snapshot = projectInFlightRunSnapshot({ chatRunState, runId, startedAtMs: 1000 });
    const rows = swatchRows(...parts).slice(page === "without input" ? 1 : 0);
    const maxBytes = jsonUtf8Bytes(rows) + jsonUtf8Bytes({ ...snapshot, events: [] });
    const run =
      page === "bounded"
        ? boundInFlightRunSnapshotForChatHistory({ snapshot, messages: rows, maxBytes })
        : snapshot;
    if (page === "bounded") {
      expect(run?.events).toEqual([]);
      expect(jsonUtf8Bytes(rows) + jsonUtf8Bytes(run)).toBeLessThanOrEqual(maxBytes);
    }
    const state = createState({ ...activeHistory(runId), messages: rows, inFlightRun: run });
    vi.stubGlobal("window", globalThis);
    try {
      await loadChatHistory(state);
      expect(renderedText(state).filter(Boolean)).toEqual(
        [page !== "without input" && "Read the swatches.", ...parts, "Final result."].filter(
          Boolean,
        ),
      );
      assistant(state, runId, text + "\n\n" + SWATCH_OPENING);
      expect(tail(state)?.trim()).toBe("Final result.\n\n" + SWATCH_OPENING);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  ["cumulative", ""],
  ["cumulative", SWATCH_SUFFIX],
  ["cold", SWATCH_OPENING + SWATCH_SUFFIX],
  ["commentary", ""],
  ["commentary", SWATCH_OPENING + SWATCH_SUFFIX],
  ["independent", SWATCH_OPENING],
  ["independent", SWATCH_OPENING + SWATCH_SUFFIX],
  ["retired", SWATCH_OPENING],
  ["retired", SWATCH_OPENING + SWATCH_SUFFIX],
])("keeps each occurrence in full and bounded %s history with reply %j", async (mode, reply) => {
  const rows = mode === "cold" ? swatchRows() : swatchRows(SWATCH_OPENING);
  const chatRunState = createChatRunState();
  const runId = SWATCH_RUN;
  const buffer = (text: string) => chatRunState.updateBuffer(runId, { itemId: "assistant", text });
  const start = toolEvent("read-0");
  const cumulative = mode === "cumulative" || mode === "cold";
  if (cumulative || mode === "retired") {
    buffer(SWATCH_OPENING);
    start.data.textLengthBeforeTool = chatRunState.resolveBuffer(runId).text.length;
  } else if (mode === "commentary") {
    chatRunState.recordProgressEvent(
      runId,
      event(1, "item", {
        kind: "preamble",
        itemId: "commentary-1",
        phase: "end",
        progressText: SWATCH_OPENING,
      }),
    );
  }
  chatRunState.recordProgressEvent(runId, start);
  const raw = (cumulative ? SWATCH_OPENING : "") + reply;
  if (mode === "retired") {
    chatRunState.retireBuffer(runId, ["assistant"]);
    chatRunState.updateBuffer(runId, { itemId: "later-reply", text: reply });
  } else if (reply) {
    buffer(raw);
  }
  const snapshot = projectInFlightRunSnapshot({ chatRunState, runId, startedAtMs: 1000 });
  if (mode === "retired") {
    expect(snapshot.text).toBe(reply);
    expect(snapshot.events?.[0]?.data).toMatchObject({
      textLengthBeforeTool: SWATCH_OPENING.length,
    });
    expect(snapshot.events?.[0]?.data.bufferEnd).toBeUndefined();
  }
  const maxBytes = jsonUtf8Bytes(rows) + jsonUtf8Bytes({ ...snapshot, events: [] });
  const bounded = boundInFlightRunSnapshotForChatHistory({ snapshot, messages: rows, maxBytes });
  expect(bounded?.events).toEqual([]);
  expect(jsonUtf8Bytes(rows) + jsonUtf8Bytes(bounded)).toBeLessThanOrEqual(maxBytes);
  for (const run of [snapshot, bounded]) {
    const history = activeSnapshot(SWATCH_RUN, "", rows);
    history.inFlightRun = run;
    const state = createState(history);
    await (run === snapshot ? loadWithTools(state) : loadChatHistory(state));
    const hasOpening = mode !== "cold" || run === snapshot;
    const visible = (hasOpening ? reply : raw).trim();
    expect(renderedText(state).filter(Boolean)).toEqual(
      ["Read the swatches.", hasOpening && SWATCH_OPENING, visible].filter(Boolean),
    );
    expect(tail(state)?.trim() ?? "").toBe(visible);
    assistant(state, SWATCH_RUN, raw + "\n\nResult.");
    expect(tail(state)?.trim()).toBe((visible + "\n\nResult.").trim());
  }
});

it.each([
  [SWATCH_OPENING + " New answer.", false],
  [SWATCH_OPENING + "\n\nCobalt.", true],
  [SWATCH_OPENING + "\n\nCobalt.", false],
] as const)(
  "keeps a reply that repeats imported text (reply %j, events evicted: %s)",
  async (reply, evicted) => {
    const history = activeSnapshot(SWATCH_RUN, reply, swatchRows(SWATCH_OPENING, "Cobalt."));
    if (evicted) {
      history.inFlightRun!.events = [];
    }
    const state = createState(history);
    await loadChatHistory(state);
    expect(tail(state)).toBe(reply);
  },
);

it("does not apply a stale tool span to a newer live reply with the same opening", async () => {
  const history = activeSnapshot(SWATCH_RUN, SWATCH_OPENING, swatchRows(SWATCH_OPENING));
  const start = toolEvent("read-0");
  start.data.bufferEnd = SWATCH_OPENING.length;
  history.inFlightRun!.events = [start];
  const { state, response } = delayed(history);
  const reply = SWATCH_OPENING + SWATCH_SUFFIX;
  vi.stubGlobal("window", globalThis);
  try {
    assistant(state, SWATCH_RUN, SWATCH_OPENING, { seq: 1 });
    const loading = loadChatHistory(state);
    assistant(state, SWATCH_RUN, reply, { seq: 2, replace: true, deltaText: reply });
    response.resolve(history);
    await loading;
    expect(tail(state)).toBe(reply);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("resolves a bounded prefix on its wire page before filling a held history gap", async () => {
  const rows = swatchRows(SWATCH_OPENING);
  const history = activeSnapshot(SWATCH_RUN, "", rows);
  history.sessionInfo!.sessionId = "swatches";
  const earlier = message("assistant", "Earlier turn.", { id: "earlier", seq: 1 });
  const held = { messages: [earlier], sessionInfo: history.sessionInfo, totalMessages: 1 };
  const state = createState(history);
  vi.spyOn(state.client!, "request")
    .mockResolvedValueOnce({ ...held, deltaCursor: "prior" })
    .mockResolvedValueOnce({ kind: "reset" })
    .mockResolvedValueOnce({
      ...history,
      inFlightRun: { runId: SWATCH_RUN, text: "", textFromMessage: 1, events: [] },
      hasMore: true,
      nextOffset: rows.length,
      totalMessages: rows.length + 1,
      olderCursor: "before-swatch",
    })
    .mockResolvedValueOnce(held);
  await loadChatHistory(state);
  await loadChatHistory(state);
  expect(state.chatMessages).toEqual([earlier, ...rows]);
  assistant(state, SWATCH_RUN, SWATCH_OPENING + "\n\nResult.");
  expect(tail(state)?.trim()).toBe("Result.");
});

it("does not bind an earlier start to a later history buffer without an imported call", async () => {
  const opening = "Amber.";
  const reply = "Amber. New page.";
  const snapshot = activeSnapshot("run-live", reply);
  const start = toolEvent("native-read");
  start.data.textLengthBeforeTool = opening.length;
  snapshot.inFlightRun!.events = [start];
  const state = createState(snapshot);
  await loadWithTools(state);
  expect(tail(state)).toBe(reply);
  expect(renderedText(state).filter((text) => text?.includes(opening))).toEqual([reply]);
});

it("retains unchanged stream segments when history replaces the live text", async () => {
  const snapshot = activeSnapshot("run-live", "Before refresh.");
  const state = createState(snapshot);
  await loadChatHistory(state);
  const segments = state.chatStreamSegments;
  snapshot.inFlightRun!.text = "After refresh.";

  await loadChatHistory(state);

  expect(state.chatStream).toBe("After refresh.");
  expect(state.chatStreamSegments).toBe(segments);
});

it("keeps live tool authority until history records its outcome, not just its call", async () => {
  const runId = "run-live";
  const toolCallId = "build";
  const args = { title: "Run build and compatibility gates", code: "await build()" };
  const call = {
    role: "assistant",
    __openclaw: { id: "build-call", runId, seq: 1 },
    content: [{ type: "toolCall", id: toolCallId, name: "exec", arguments: args }],
  };
  const history = activeHistory(runId);
  history.messages = [call];
  const entries = [{ messageId: "build-call", message: call }];
  history.activity = projectAgentHistoryActivity(entries);
  const state = createState(history);
  adoptStartedChatRun(state, runId, 1_000);
  vi.stubGlobal("window", globalThis);
  try {
    handleAgentEvent(state, event(1, "tool", { phase: "start", toolCallId, name: "exec", args }));
    handleAgentEvent(
      state,
      event(
        2,
        "item",
        projectAgentToolActivity({
          toolCallId,
          name: "exec",
          args,
          phase: "start",
        }),
      ),
    );
    expect(state.toolStreamOrder).toHaveLength(1);
    await vi.waitFor(() => expect(state.chatToolMessages).toHaveLength(1));
    await loadChatHistory(state);
    expect(state.chatToolMessages).toMatchObject([
      {
        toolCallId,
        activity: [{ status: "running" }],
      },
    ]);
    const result = {
      role: "toolResult",
      toolCallId,
      toolName: "exec",
      isError: false,
      __openclaw: { id: "build-result", runId, seq: 2 },
      content: [{ type: "text", text: "Build passed" }],
    };
    history.messages = [call, result];
    history.activity = projectAgentHistoryActivity([
      ...entries,
      { messageId: "build-result", message: result },
    ]);
    await loadChatHistory(state);
    expect(state.chatToolMessages).toEqual([]);
    expect(state.chatMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          activity: [expect.objectContaining({ status: "completed" })],
        }),
      ]),
    );
  } finally {
    vi.unstubAllGlobals();
  }
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
      ["chat.abort", { sessionKey: "main", runId: "run-missed-terminal", userInitiated: true }],
    ]);
    expect(state.chatRunId).toBe("run-current");
    expect(state.chatStream).toBe("The current response.");
    assistant(state, "run-current", "The current response. Continued.");
    expect(state.chatStream).toBe("The current response. Continued.");

    await handleAbortChat(state, { preserveDraft: true });

    expect(abortCalls()).toEqual([
      ["chat.abort", { sessionKey: "main", runId: "run-missed-terminal", userInitiated: true }],
      ["chat.abort", { sessionKey: "main", runId: "run-current", userInitiated: true }],
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

it("reconciles cached identical steers by send identity after reload", async () => {
  const runId = "active-run";
  const state = createState(activeSnapshot(runId));
  const sends = ["a", "b"];
  const cached = sends.map((sendId) =>
    buildLocalUserMessage({
      text: "Keep going",
      runId: sendId,
      steerTargetRunId: runId,
      createdAt: 1,
      sender: { id: "owner" },
    }),
  );
  applyChatCacheSnapshot(state, {
    messages: cached,
    sessionId: "session-one",
    pagination: state.chatHistoryPagination,
  });
  const receipts = sends.map((sendId, index) =>
    message("user", "Keep going", {
      id: `durable-${sendId}`,
      seq: index + 1,
      idempotencyKey: `${sendId}:user`,
    }),
  );
  for (const [index, receipt] of receipts.entries()) {
    publish(state, runId, { message: receipt });
    publish(state, runId, {
      message: {
        ...receipt,
        __openclaw: { ...receipt["__openclaw"], steerTargetRunId: runId },
      },
    });
    // Each receipt replaces one cached steer; identical text never collapses or duplicates them.
    expect(renderedText(state)).toEqual(["Keep going", "Keep going"]);
    expect(state.chatMessages.slice(0, index + 1)).toMatchObject(receipts.slice(0, index + 1));
  }
  vi.spyOn(state.client!, "request").mockResolvedValue({ messages: receipts });
  await loadChatHistory(state);
  expect(state.chatMessages).toEqual(receipts);
});
