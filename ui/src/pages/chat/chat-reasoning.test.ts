/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { extractThinkingCached } from "../../lib/chat/message-extract.ts";
import { createComposerContainer } from "./chat-composer.test-support.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import {
  activeHistory,
  createState,
  type TestState,
} from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { buildCachedChatItems, getChatItemsGeneration } from "./chat-thread.ts";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatInto } from "./chat-view.test-helpers.ts";
import { projectTranscriptChain } from "./components/chat-transcript-message-index.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";
import { reduceChatSessionProjection } from "./history-merge.ts";
import { adoptStartedChatRun, reconcileChatRunFromSessionRow } from "./run-lifecycle.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { cacheChatSessionSnapshot, readChatMessagesFromCache } from "./session-message-cache.ts";
import { resetToolStream } from "./tool-stream-state.ts";
import { handleAgentEvent } from "./tool-stream.ts";

const runId = "reasoning-run";
const user = {
  role: "user",
  content: "Explain a synthetic puzzle.",
  timestamp: 1,
  __openclaw: { id: "user", seq: 1, idempotencyKey: `${runId}:user` },
};

beforeEach(() => {
  vi.useFakeTimers();
  installTranscriptDomMocks();
});
afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function stateWithRun() {
  const history = activeHistory(runId);
  history.messages = [user];
  const state = createState(history);
  state.chatMessages = [user];
  adoptStartedChatRun(state, runId, 2);
  return state;
}

function thinking(state: TestState, text: string, seq = 1, owner = runId, itemId = "thinking-1") {
  handleAgentEvent(state, {
    runId: owner,
    seq,
    stream: "thinking",
    ts: 3,
    sessionKey: "main",
    data: { text, delta: text, itemId },
  });
}

function show(
  container: HTMLElement,
  state: TestState,
  mode: "on" | "off" | "stream" = "on",
  showThinking = true,
) {
  renderChatInto(container, {
    messages: state.chatMessages,
    reasoning: state.chatReasoning,
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    runId: state.chatRunId,
    runActive: Boolean(state.chatRunId),
    selectedSession: { key: "main", kind: "direct", updatedAt: 1, reasoningLevel: mode },
    showThinking,
  });
}

function persistReasoning(
  state: TestState,
  text: string,
  active: boolean,
  positions = { appended: 2, displayed: 2 },
) {
  handleAgentEvent(state, {
    runId,
    seq: 2,
    stream: "thinking",
    ts: 4,
    sessionKey: "main",
    data: {
      phase: "persisted",
      itemId: "thinking-1",
      messageId: "answer",
      messageSeq: positions.appended,
      messageRunId: runId,
    },
  });
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: text },
      { type: "text", text: "The answer is 42." },
    ],
    timestamp: 4,
    stopReason: "stop",
    __openclaw: { id: "answer", seq: positions.displayed, runId, runTerminal: true },
  };
  applySessionMessagePayload(
    state,
    { message, runId, messageId: "answer", messageSeq: positions.displayed },
    active,
    { kind: "live", activeRunId: state.chatRunId },
  );
  return message;
}

it("shows thinking while generating and retains it through thinking-only history hydration", async () => {
  const state = stateWithRun();
  const container = createComposerContainer();
  thinking(state, "**Checking** the evidence.");
  show(container, state);
  expect(container.querySelector(".chat-thinking strong")?.textContent).toBe("Checking");
  expect(state.chatMessages).toEqual([user]);

  await loadChatHistory(state);
  show(container, state);
  expect(container.querySelector(".chat-thinking")?.textContent).toContain("the evidence.");
  expect(state.chatRunId).toBe(runId);
});

it.each([
  { order: "before", appended: 2, displayed: 2 },
  { order: "after", appended: 2, displayed: 2 },
  // Reset projection can renumber positions while the durable message ID stays fixed.
  { order: "before", appended: 18, displayed: 7 },
])(
  "hands reasoning to history once $order final (append $appended, display $displayed)",
  async ({ order, appended, displayed }) => {
    const state = stateWithRun();
    const container = createComposerContainer();
    const text = "Checking the evidence carefully.";
    thinking(state, text);
    show(container, state);
    expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
    if (order === "before") {
      persistReasoning(state, text, true, { appended, displayed });
      show(container, state);
      expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
      expect(state.chatReasoning?.items.at(-1)?.receipt?.persisted).toBe(true);
    }
    handleChatGatewayEvent(state, {
      state: "final",
      sessionKey: "main",
      runId,
      seq: 3,
      message: { role: "assistant", content: [{ type: "text", text: "The answer is 42." }] },
    });
    show(container, state);
    expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
    expect(
      container.querySelector(".chat-thread-inner")?.textContent?.match(/The answer is 42\./g),
    ).toHaveLength(1);
    expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
      "The answer is 42.",
    );
    expect(state.chatReasoning).toBeNull();
    if (order === "after") {
      // An intervening older snapshot must retain the reducer-owned live final.
      await loadChatHistory(state);
      expect(state.chatMessages.map(extractThinkingCached)).toContain(text);
      persistReasoning(state, text, false, { appended, displayed });
      show(container, state);
      expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
      expect(
        container.querySelector(".chat-thread-inner")?.textContent?.match(/The answer is 42\./g),
      ).toHaveLength(1);
      expect(container.querySelector(".chat-transcript-announcement")?.textContent).toBe(
        "The answer is 42.",
      );
    }
    expect(state.chatMessages).toHaveLength(2);
  },
);

it("applies View and session visibility independently to live and saved reasoning", () => {
  const state = stateWithRun();
  const container = createComposerContainer();
  thinking(state, "Private synthetic reasoning.");
  for (const [mode, visible] of [
    ["on", true],
    ["stream", true],
    ["off", false],
  ] as const) {
    show(container, state, mode);
    expect(Boolean(container.querySelector(".chat-thinking"))).toBe(visible);
    show(container, state, mode, false);
    expect(container.querySelector(".chat-thinking")).toBeNull();
  }
  persistReasoning(state, "Private synthetic reasoning.", true);
  for (const mode of ["on", "stream"] as const) {
    show(container, state, mode);
    expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
    expect(container.querySelector(".chat-thinking")?.textContent).toContain("Private synthetic");
  }
  handleChatGatewayEvent(state, {
    state: "final",
    sessionKey: "main",
    runId,
    seq: 2,
    message: { role: "assistant", content: [{ type: "text", text: "The answer is 42." }] },
  });
  show(container, state, "stream");
  expect(container.querySelector(".chat-thinking")).toBeNull();
  show(container, state, "on");
  expect(container.querySelector(".chat-thinking")?.textContent).toContain("Private synthetic");
});

it.each(["error", "aborted", "final"] as const)(
  "retires reasoning on a message-less %s and ignores late thinking after sequence cleanup",
  (terminal) => {
    const state = stateWithRun();
    thinking(state, "Unfinished reasoning.");
    handleChatGatewayEvent(state, {
      state: terminal,
      sessionKey: "main",
      runId,
      seq: 3,
      ...(terminal === "error" ? { errorMessage: "Synthetic interruption" } : {}),
    });
    resetToolStream(state);
    thinking(state, "Late reasoning.", 4);
    expect(state.chatReasoning).toBeNull();
    expect(state.chatMessages.map(extractThinkingCached).filter(Boolean)).toEqual([]);
  },
);

it("fences replay and sibling runs and retires preview on a new run or session reset", () => {
  const state = stateWithRun();
  thinking(state, "Current reasoning.", 3);
  thinking(state, "Stale reasoning.", 2);
  thinking(state, "Sibling reasoning.", 4, "other-run");
  expect(state.chatReasoning?.items.at(-1)?.text).toBe("Current reasoning.");
  adoptStartedChatRun(state, "new-run", 10);
  expect(state.chatReasoning).toBeNull();
  thinking(state, "New reasoning.", 1, "new-run");
  reduceChatSessionProjection(state, { type: "sessionReset" });
  expect(state.chatReasoning).toBeNull();
});

it("updates reasoning deltas in the existing live slot without rebuilding loaded history", () => {
  const state = stateWithRun();
  thinking(state, "Earlier tool reasoning.", 1, runId, "earlier");
  thinking(state, "First sentence.", 2);
  const input = {
    paneId: "reasoning-cache",
    sessionKey: "main",
    runId,
    messages: state.chatMessages,
    toolMessages: [],
    streamSegments: [],
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    reasoning: state.chatReasoning,
    showToolCalls: true,
  };
  const first = buildCachedChatItems(input);
  const generation = getChatItemsGeneration(first);
  const options = { sessionKey: "main", runWorking: true, searchActive: false };
  const firstChain = projectTranscriptChain(first, options);
  thinking(state, "First sentence. Second sentence.", 3);
  const second = buildCachedChatItems({ ...input, reasoning: state.chatReasoning });
  expect(second).toBe(first);
  expect(getChatItemsGeneration(second)).toBe(generation);
  expect(projectTranscriptChain(second, options).continuations).toBe(firstChain.continuations);
  expect(second.find((item) => item.kind === "stream" && item.isStreaming)).toMatchObject({
    thinking: "First sentence. Second sentence.",
  });
});

it("does not attach foreground thinking to another session's final with the same run ID", () => {
  const state = stateWithRun();
  thinking(state, "Foreground private reasoning.");
  state.chatMessagesBySession = new Map();
  cacheChatSessionSnapshot(
    state.chatMessagesBySession,
    state,
    { sessionKey: "other-session" },
    {
      messages: [],
      pagination: { hasMore: false },
      sessionId: "other-session-id",
    },
  );
  handleChatGatewayEvent(state, {
    state: "final",
    sessionKey: "other-session",
    runId,
    seq: 2,
    message: { role: "assistant", content: [{ type: "text", text: "Other session answer." }] },
  });
  expect(state.chatReasoning?.items.at(-1)?.text).toBe("Foreground private reasoning.");
  const cached = readChatMessagesFromCache(state.chatMessagesBySession, state, {
    sessionKey: "other-session",
  });
  expect(cached).toHaveLength(1);
  expect(cached.map(extractThinkingCached)).toEqual([null]);
});

it("accepts pre-acknowledgment reasoning but retires it when the authoritative session ends", () => {
  const state = stateWithRun();
  state.chatRunId = null;
  state.chatQueue = [
    { id: "pending", text: "Puzzle", createdAt: 1, sendState: "sending", sendRunId: runId },
  ];
  thinking(state, "Before acknowledgment.");
  expect(state.chatReasoning?.items.at(-1)?.text).toBe("Before acknowledgment.");
  adoptStartedChatRun(state, runId, 2);
  state.chatQueue = [];
  reconcileChatRunFromSessionRow(state, {
    key: "main",
    kind: "direct",
    updatedAt: 5,
    hasActiveRun: false,
    lastRunId: runId,
    status: "done",
  });
  thinking(state, "After retirement.", 2);
  expect(state.chatReasoning).toBeNull();
});

it("does not let an earlier receipt consume equal reasoning from the next assistant occurrence", () => {
  const state = stateWithRun();
  const container = createComposerContainer();
  const text = "Checking the same evidence.";
  thinking(state, text, 1, runId, "earlier");
  thinking(state, text, 2, runId, "later");
  show(container, state);
  expect(container.querySelectorAll(".chat-thinking")).toHaveLength(2);
  handleAgentEvent(state, {
    runId,
    seq: 3,
    stream: "thinking",
    ts: 4,
    sessionKey: "main",
    data: { phase: "persisted", itemId: "earlier", messageId: "earlier", messageRunId: runId },
  });
  applySessionMessagePayload(
    state,
    {
      runId,
      messageId: "earlier",
      messageSeq: 2,
      message: {
        role: "assistant",
        timestamp: 3,
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: text },
          { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
        ],
        __openclaw: { id: "earlier", seq: 2, runId },
      },
    },
    true,
    { kind: "live", activeRunId: runId },
  );
  expect(state.chatReasoning?.items.at(-1)).toMatchObject({ itemId: "later", text });
  expect(state.chatReasoning?.items.at(-1)?.receipt?.messageId).toBeUndefined();
  for (const mode of ["on", "stream"] as const) {
    show(container, state, mode);
    expect(container.querySelectorAll(".chat-thinking")).toHaveLength(2);
  }
});

it("does not attach known-committed pre-tool reasoning to a later final answer", () => {
  const state = stateWithRun();
  thinking(state, "Reasoning belonging to the tool call.");
  handleAgentEvent(state, {
    runId,
    seq: 2,
    stream: "thinking",
    ts: 4,
    sessionKey: "main",
    data: {
      phase: "persisted",
      itemId: "thinking-1",
      messageId: "tool-answer",
      messageRunId: runId,
    },
  });
  handleChatGatewayEvent(state, {
    state: "final",
    sessionKey: "main",
    runId,
    seq: 3,
    message: { role: "assistant", content: [{ type: "text", text: "Separate final answer." }] },
  });
  expect(state.chatMessages.map(extractThinkingCached).filter(Boolean)).toEqual([]);
});

it("removes a worker's explicitly cleared reasoning before the final answer", () => {
  const state = stateWithRun();
  const container = createComposerContainer();
  thinking(state, "A discarded draft.");
  show(container, state);
  expect(container.querySelector(".chat-thinking")).not.toBeNull();
  thinking(state, "", 2);
  show(container, state);
  expect(container.querySelector(".chat-thinking")).toBeNull();
  handleChatGatewayEvent(state, {
    state: "final",
    sessionKey: "main",
    runId,
    seq: 3,
    message: { role: "assistant", content: [{ type: "text", text: "The final answer." }] },
  });
  expect(state.chatMessages.map(extractThinkingCached).filter(Boolean)).toEqual([]);
});

it("clears only the worker's current occurrence without adopting an earlier tool thought as the final", () => {
  const state = stateWithRun();
  const container = createComposerContainer();
  thinking(state, "Keep the earlier tool reasoning.", 1, runId, "earlier");
  thinking(state, "Discard the current draft.", 2, runId, "later");
  thinking(state, "", 3, runId, "later");
  show(container, state);
  expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
  expect(container.querySelector(".chat-thinking")?.textContent).toContain(
    "Keep the earlier tool reasoning.",
  );
  handleChatGatewayEvent(state, {
    state: "final",
    sessionKey: "main",
    runId,
    seq: 4,
    message: { role: "assistant", content: [{ type: "text", text: "The final answer." }] },
  });
  expect(state.chatMessages.map(extractThinkingCached).filter(Boolean)).toEqual([]);
});

it("uses the producer run in the receipt when Gateway remaps the live client run", () => {
  const state = stateWithRun();
  thinking(state, "A remapped source occurrence.");
  handleAgentEvent(state, {
    runId,
    seq: 2,
    stream: "thinking",
    ts: 4,
    sessionKey: "main",
    data: {
      phase: "persisted",
      itemId: "thinking-1",
      messageId: "source-answer",
      messageRunId: "source-run",
    },
  });
  applySessionMessagePayload(
    state,
    {
      runId: "source-run",
      clientRunId: runId,
      messageId: "source-answer",
      messageSeq: 2,
      message: {
        role: "assistant",
        timestamp: 4,
        content: [
          { type: "thinking", thinking: "A remapped source occurrence." },
          { type: "text", text: "Source answer." },
        ],
        __openclaw: { id: "source-answer", seq: 2, runId: "source-run" },
      },
    },
    true,
    { kind: "live", activeRunId: runId },
  );
  expect(state.chatReasoning?.items.at(-1)?.receipt).toEqual({
    runId: "source-run",
    messageId: "source-answer",
    persisted: true,
  });
  const container = createComposerContainer();
  show(container, state);
  expect(container.querySelectorAll(".chat-thinking")).toHaveLength(1);
});
